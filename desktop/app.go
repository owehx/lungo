package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"runtime"
	"slices"
	"sort"
	"strings"
	"sync"
	"time"

	wruntime "github.com/wailsapp/wails/v2/pkg/runtime"

	"skybuild/internal/apikeys"
	"skybuild/internal/config"
	"skybuild/internal/engine"
	"skybuild/internal/events"
	"skybuild/internal/folders"
	"skybuild/internal/model"
	"skybuild/internal/osx"
	"skybuild/internal/paths"
	"skybuild/internal/provider"
	"skybuild/internal/syncer"
	"skybuild/internal/term"
)

// Version is set at build time with -ldflags "-X main.Version=…" (appVersion falls back to
// the bundle's Info.plist).
var Version = "dev"

// App is bound to the frontend: every exported method is callable from TypeScript.
type App struct {
	ctx   context.Context
	eng   *engine.Engine
	terms *term.Manager
	ops   *opRunner

	statusMu   sync.Mutex
	statuses   []model.ProviderStatus
	statusedAt time.Time

	watchMu sync.Mutex
	watches map[string]context.CancelFunc // link ID → stop

	poll  *poller
	win   *window
	share *sharing      // sessions shared with people on the tailnet, and joined (collab.go)
	ready chan struct{} // closed when startup has finished
}

func NewApp() *App {
	return &App{eng: engine.New(), watches: map[string]context.CancelFunc{}, win: newWindow(), share: newSharing(), ready: make(chan struct{})}
}

// startup runs alongside the page loading, not before it (Wails starts both at once), so the
// page can be up and calling in while this is still going. Everything a call from the page
// touches is therefore made first, in an instant; the slow parts come after.
func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
	a.ops = newOpRunner(ctx)
	a.poll = newPoller(a)
	tm, err := term.NewManager()
	if err != nil {
		wruntime.LogErrorf(ctx, "terminal server: %v", err)
	}
	a.terms = tm
	if tm != nil {
		tm.OnExit = func(id string, code int) {
			wruntime.EventsEmit(ctx, "term:exit", map[string]any{"id": id, "code": code})
		}
	}
	a.startSharing()
	defer close(a.ready)
	if os.Getenv("SKY_HEADLESS") != "" {
		backgroundApp()
	}
	osx.FixPath() // asks the login shell for PATH: the slow part
	_ = paths.Ensure()
	startIcon()
	refreshLoginItem()
	a.win.start()
	a.win.onQuitAsked(func() { wruntime.Quit(ctx) })
	watchClose()
	a.restoreFrame()
	a.forgetFrames()
}

// domReady starts the background work once the page is up and startup is through.
func (a *App) domReady(ctx context.Context) {
	<-a.ready
	compactTitleBar()
	keepDrawn()
	go a.poll.run(ctx)
	go func() { _ = a.eng.SyncSSHConfig() }()
	go a.healthLoop(ctx)
	go engine.TidyPeek()
	go engine.InstallLocalPeek()
	go func() { _ = a.eng.SyncLocalLogin(ctx) }()
	go a.iconLoop(ctx)
	go a.win.reopen()
	go a.updateLoop(ctx)
	go a.watchPrefs(ctx)
	a.runSharing()
	go a.win.watchAsks(func(verb, machine, session string) {
		wruntime.EventsEmit(ctx, "window-ask", map[string]string{"verb": verb, "machine": machine, "session": session})
	})
}

func (a *App) shutdown(context.Context) {
	a.win.close()
	a.forgetFrames()
	if a.terms != nil {
		a.terms.CloseAll()
	}
	a.stopSharing()
	a.eng.CloseAllTunnels()
	a.watchMu.Lock()
	for _, stop := range a.watches {
		stop()
	}
	a.watchMu.Unlock()
}

// ---------- app info ----------

// AppInfo is static information the UI needs once.
type AppInfo struct {
	Version   string           `json:"version"`
	Platform  string           `json:"platform"` // darwin | windows | linux
	Home      string           `json:"home"`
	LocalUser string           `json:"localUser"`
	ConfigDir string           `json:"configDir"`
	Terminals []string         `json:"terminals"`
	SyncItems []syncer.Item    `json:"syncItems"`
	CredNames []string         `json:"credentialNames"`
	Providers []ProviderSketch `json:"providers"`
	AppIcon   string           `json:"appIcon"` // the icon picked in Settings
}

// ProviderSketch is the static part of a provider (no CLI calls).
type ProviderSketch struct {
	ID    string `json:"id"`
	Label string `json:"label"`
}

func (a *App) Info() AppInfo {
	info := AppInfo{
		Version: appVersion(), Platform: runtime.GOOS, Home: paths.Home(), LocalUser: config.LocalUser(),
		ConfigDir: paths.Root(), Terminals: osx.Terminals(), SyncItems: syncer.Items(), CredNames: syncer.CredentialNames(),
		AppIcon: chosenIcon(),
	}
	for _, p := range a.eng.Providers() {
		info.Providers = append(info.Providers, ProviderSketch{ID: p.ID(), Label: p.Label()})
	}
	return info
}

// ---------- machines ----------

// MachineView is a machine plus what the UI shows next to it.
type MachineView struct {
	Machine       *model.Machine `json:"machine"`
	ProviderLabel string         `json:"providerLabel"`
	SSHShort      string         `json:"sshShort"`
	SSHFull       string         `json:"sshFull"`
	Address       string         `json:"address"`
	Monthly       float64        `json:"monthly"`     // estimate: VM + data volume, while running all month
	StoppedCost   float64        `json:"stoppedCost"` // estimate while stopped (volume only)
	CPUs          int            `json:"cpus"`
	MemoryGB      float64        `json:"memoryGB"`
}

var diskPerGB = map[string]float64{model.ProviderGCP: 0.10, model.ProviderAWS: 0.08, model.ProviderAzure: 0.075}

func (a *App) view(m *model.Machine) MachineView {
	v := MachineView{Machine: m}
	if m.Sync == nil {
		m.Sync = []string{}
	}
	v.SSHShort, v.SSHFull = a.eng.SSHCommands(m)
	v.Address = a.eng.Target(m).Host
	if m.SSHAlias != "" {
		v.Address = m.SSHAlias
	}
	v.ProviderLabel = "Your machine"
	if p, err := a.eng.Provider(m.Provider); err == nil {
		v.ProviderLabel = p.Label()
		if s, ok := provider.SizeByID(p.Sizes(), m.Size); ok {
			v.Monthly = s.Monthly
			v.CPUs, v.MemoryGB = s.CPUs, s.MemoryGB
		}
		disk := float64(m.DiskGB) * diskPerGB[m.Provider]
		v.Monthly += disk
		v.StoppedCost = disk
	}
	return v
}

func (a *App) views(ms []*model.Machine) []MachineView {
	out := make([]MachineView, 0, len(ms))
	for _, m := range ms {
		out = append(out, a.view(m))
	}
	return out
}

// Machines returns saved machines without contacting any cloud.
func (a *App) Machines() ([]MachineView, error) {
	ms, err := a.eng.Machines()
	if err != nil {
		return nil, err
	}
	return a.views(ms), nil
}

// RefreshMachines asks each cloud for live status.
func (a *App) RefreshMachines() ([]MachineView, error) {
	ms, err := a.eng.Refresh(a.ctx)
	if err != nil {
		return nil, err
	}
	v := a.views(ms)
	wruntime.EventsEmit(a.ctx, "machines", v)
	return v, nil
}

// ---------- providers ----------

// ProviderStatuses checks every cloud CLI (a few seconds); cached for 60s unless force.
func (a *App) ProviderStatuses(force bool) []model.ProviderStatus {
	a.statusMu.Lock()
	if !force && a.statuses != nil && time.Since(a.statusedAt) < 60*time.Second {
		s := a.statuses
		a.statusMu.Unlock()
		return s
	}
	a.statusMu.Unlock()
	ctx, cancel := context.WithTimeout(a.ctx, 45*time.Second)
	defer cancel()
	s := a.eng.ProviderStatuses(ctx)
	for i := range s {
		if s[i].Accounts == nil {
			s[i].Accounts = []model.Account{}
		}
	}
	a.statusMu.Lock()
	a.statuses, a.statusedAt = s, time.Now()
	a.statusMu.Unlock()
	return s
}

// Catalog is what the new-machine wizard offers for a provider.
type Catalog struct {
	Provider      string         `json:"provider"`
	Regions       []model.Region `json:"regions"`
	Sizes         []model.Size   `json:"sizes"`
	DefaultRegion string         `json:"defaultRegion"`
	DiskPerGB     float64        `json:"diskPerGB"`
}

func (a *App) Catalog(providerID string) (Catalog, error) {
	p, err := a.eng.Provider(providerID)
	if err != nil {
		return Catalog{}, err
	}
	c := Catalog{Provider: p.ID(), Regions: p.Regions(), Sizes: p.Sizes(), DefaultRegion: p.DefaultRegion(), DiskPerGB: diskPerGB[p.ID()]}
	if c.Regions == nil {
		c.Regions = []model.Region{}
	}
	if c.Sizes == nil {
		c.Sizes = []model.Size{}
	}
	return c, nil
}

// FillSpec completes a partial spec from saved defaults.
func (a *App) FillSpec(s model.Spec) (model.Spec, error) {
	err := a.eng.FillSpec(&s)
	return s, err
}

// ---------- long operations ----------

func (a *App) Login(providerID string) string {
	return a.ops.start("login", "Connect "+providerID, "", func(ctx context.Context, r events.Reporter) (any, error) {
		err := a.eng.Login(ctx, providerID, r)
		a.statusMu.Lock()
		a.statuses = nil
		a.statusMu.Unlock()
		return nil, err
	})
}

func (a *App) CreateMachine(s model.Spec) string {
	return a.ops.start("create", "Create "+s.Name, s.Name, func(ctx context.Context, r events.Reporter) (any, error) {
		m, err := a.eng.Create(ctx, s, r)
		a.emitMachines()
		if m == nil {
			return nil, err
		}
		return a.view(m), err
	})
}

func (a *App) AddMachine(s engine.AddSpec) string {
	return a.ops.start("add", "Add "+s.Name, s.Name, func(ctx context.Context, r events.Reporter) (any, error) {
		m, err := a.eng.Add(ctx, s, r)
		a.emitMachines()
		if m == nil {
			return nil, err
		}
		return a.view(m), err
	})
}

func (a *App) StartMachine(name string) string {
	return a.machineOp("start", "Start "+name, name, func(ctx context.Context, r events.Reporter) error { return a.eng.Start(ctx, name, r) })
}

func (a *App) StopMachine(name string) string {
	return a.machineOp("stop", "Stop "+name, name, func(ctx context.Context, r events.Reporter) error { return a.eng.Stop(ctx, name, r) })
}

func (a *App) RestartMachine(name string) string {
	return a.machineOp("restart", "Restart "+name, name, func(ctx context.Context, r events.Reporter) error { return a.eng.Restart(ctx, name, r) })
}

func (a *App) ResizeMachine(name, size string) string {
	return a.machineOp("resize", "Resize "+name+" → "+size, name, func(ctx context.Context, r events.Reporter) error {
		return a.eng.Resize(ctx, name, size, r)
	})
}

func (a *App) GrowDisk(name string, gb int) string {
	return a.machineOp("disk", fmt.Sprintf("Grow %s volume → %d GB", name, gb), name, func(ctx context.Context, r events.Reporter) error {
		return a.eng.GrowDisk(ctx, name, gb, r)
	})
}

func (a *App) DeleteMachine(name string, keepDisk bool) string {
	return a.machineOp("delete", "Delete "+name, name, func(ctx context.Context, r events.Reporter) error {
		return a.eng.Delete(ctx, name, keepDisk, r)
	})
}

func (a *App) JoinTailscale(name string) string {
	return a.machineOp("tailscale", "Tailscale for "+name, name, func(ctx context.Context, r events.Reporter) error {
		return a.eng.JoinTailscale(ctx, name, r)
	})
}

func (a *App) machineOp(kind, title, name string, fn func(context.Context, events.Reporter) error) string {
	return a.ops.start(kind, title, name, func(ctx context.Context, r events.Reporter) (any, error) {
		// These change where the machine answers, or whether it does: the connection its
		// terminals share is closed afterwards, so new panes don't wait on a dead one.
		closeTerms := func() {}
		switch kind {
		case "start", "stop", "restart", "resize", "delete":
			closeTerms = a.eng.TerminalConnCloser(name)
		}
		err := fn(ctx, r)
		if err == nil {
			closeTerms()
		}
		a.emitMachines()
		return nil, err
	})
}

func (a *App) emitMachines() {
	if v, err := a.Machines(); err == nil {
		wruntime.EventsEmit(a.ctx, "machines", v)
	}
}

// CancelOp stops a running operation.
func (a *App) CancelOp(id string) { a.ops.cancel(id) }

// Ops lists running and recently finished operations.
func (a *App) Ops() []OpInfo { return a.ops.list() }

// ---------- connect, ssh, ports ----------

// Connect opens the machine in the external terminal app.
func (a *App) Connect(name string) error { return a.eng.Connect(name) }

// CopyText puts text on the clipboard.
func (a *App) CopyText(s string) error {
	return wruntime.ClipboardSetText(a.ctx, s)
}

func (a *App) OpenURL(url string) error { return osx.OpenURL(url) }

func (a *App) Reveal(path string) error { return osx.Reveal(folders.Expand(path)) }

func (a *App) Ports(name string) ([]model.Port, error) {
	p, err := a.eng.Ports(a.ctx, name)
	if p == nil {
		p = []model.Port{}
	}
	return p, err
}

// OpenPort forwards a machine port to localhost and opens it in the browser.
func (a *App) OpenPort(name string, port int, browser bool) (*engine.Tunnel, error) {
	t, err := a.eng.Forward(a.ctx, name, port, 0)
	if err != nil {
		return nil, err
	}
	if browser {
		osx.OpenURL(t.URL)
	}
	wruntime.EventsEmit(a.ctx, "tunnels", a.Tunnels())
	go func() {
		<-t.Done()
		wruntime.EventsEmit(a.ctx, "tunnels", a.Tunnels())
	}()
	return t, nil
}

func (a *App) Tunnels() []*engine.Tunnel { return a.eng.Tunnels() }

func (a *App) CloseTunnel(id string) {
	a.eng.CloseTunnel(id)
	wruntime.EventsEmit(a.ctx, "tunnels", a.Tunnels())
}

func (a *App) TailscaleStatus() engine.TailscaleInfo { return a.eng.TailscaleStatus(a.ctx) }

func (a *App) SetTailscaleAuthKey(key string) error { return a.eng.SetTailscaleAuthKey(key) }

// ---------- sync ----------

func (a *App) SyncMachines(names []string, only []string) string {
	title := "Sync all machines"
	machine := ""
	if len(names) == 1 {
		title, machine = "Sync "+names[0], names[0]
	}
	return a.ops.start("sync", title, machine, func(ctx context.Context, r events.Reporter) (any, error) {
		res := a.eng.Sync(ctx, names, syncer.Options{Only: only, Interactive: true}, r)
		var problems []string
		for _, x := range res {
			for _, e := range x.Errors {
				problems = append(problems, x.Machine+": "+e)
			}
		}
		wruntime.EventsEmit(a.ctx, "sync:results", a.LastSyncAll())
		if len(problems) > 0 {
			return res, errors.New(strings.Join(problems, "\n"))
		}
		return res, nil
	})
}

// Credentials lists the CLI logins sync can copy and which ones this computer has.
func (a *App) Credentials() []syncer.Credential {
	s, _ := a.eng.Settings()
	return syncer.LocalCredentials(s.SkipCredentials)
}

func (a *App) SetSyncItems(name string, items []string) error {
	err := a.eng.SetSyncItems(name, items)
	a.emitMachines()
	return err
}

// LastSyncAll returns the last sync result per machine.
func (a *App) LastSyncAll() map[string]*syncer.Result {
	out := map[string]*syncer.Result{}
	ms, _ := a.eng.Machines()
	for _, m := range ms {
		if r := a.eng.LastSync(m.Name); r != nil {
			out[m.Name] = r
		}
	}
	return out
}

// ClaudeStatus describes the Claude login that sync hands to machines.
type ClaudeStatus struct {
	Installed bool   `json:"installed"`
	SignedIn  bool   `json:"signedIn"`
	Email     string `json:"email"`
	Org       string `json:"org"`
	HasToken  bool   `json:"hasToken"`
}

func (a *App) ClaudeStatus() ClaudeStatus {
	st := ClaudeStatus{Installed: osx.Has("claude")}
	acct := syncer.LocalAccount(paths.Home())
	if acct == nil {
		return st
	}
	st.SignedIn, st.Email = true, acct.Email()
	if org, ok := acct["organizationName"].(string); ok {
		st.Org = org
	}
	ctx, cancel := context.WithTimeout(a.ctx, 8*time.Second)
	defer cancel()
	t, _ := syncer.Token(ctx, acct, false, false)
	st.HasToken = t != ""
	return st
}

// InstallClaude installs Claude Code on this Mac with Anthropic's installer (no Node needed).
func (a *App) InstallClaude() string {
	return a.ops.start("claude-install", "Install Claude Code", "", func(ctx context.Context, r events.Reporter) (any, error) {
		return nil, engine.EnsureLocalClaude(ctx, r)
	})
}

// MintClaudeToken runs `claude setup-token` (browser approval) and stores the token.
// ---------- API keys ----------

// APIProvider is a catalogue entry for the add-key picker.
type APIProvider struct {
	apikeys.Provider
	CanTest bool `json:"canTest"`
}

func (a *App) APIProviders() []APIProvider {
	out := make([]APIProvider, 0, len(apikeys.Providers))
	for _, p := range apikeys.Providers {
		out = append(out, APIProvider{Provider: p, CanTest: p.CanTest()})
	}
	return out
}

func (a *App) APIKeys() ([]engine.APIKeyView, error) {
	v, err := a.eng.APIKeys(a.ctx)
	if v == nil {
		v = []engine.APIKeyView{}
	}
	return v, err
}

// keysOp runs a key change, then puts keys on every machine.
func (a *App) keysOp(title string, fn func() error) string {
	return a.ops.start("keys", title, "", func(ctx context.Context, r events.Reporter) (any, error) {
		if err := fn(); err != nil {
			return nil, err
		}
		a.emitKeys()
		if ms, _ := a.eng.Machines(); len(ms) > 0 {
			events.Stepf(r, "Updating keys on machines")
			a.eng.PushKeys(ctx, r)
		}
		return nil, nil
	})
}

func (a *App) SetAPIKey(name, value, provider string, machines []string) string {
	return a.keysOp("Save "+name, func() error { return a.eng.SetAPIKey(name, value, provider, machines) })
}

func (a *App) RemoveAPIKey(name string) string {
	return a.keysOp("Remove "+name, func() error { return a.eng.RemoveAPIKey(name) })
}

func (a *App) SetAPIKeySync(name string, on bool) string {
	return a.keysOp("Update "+name, func() error { return a.eng.SetAPIKeySync(name, on) })
}

func (a *App) SetAPIKeyMachines(name string, machines []string) string {
	return a.keysOp("Update "+name, func() error { return a.eng.SetAPIKeyMachines(name, machines) })
}

// KeyTest is the result of checking a key against its service.
type KeyTest struct {
	OK     bool   `json:"ok"`
	Detail string `json:"detail"`
	Error  string `json:"error,omitempty"`
}

func (a *App) TestAPIKey(name string) KeyTest {
	ok, detail, err := a.eng.TestAPIKey(a.ctx, name)
	t := KeyTest{OK: ok, Detail: detail}
	if err != nil {
		t.Error = err.Error()
	}
	return t
}

func (a *App) emitKeys() {
	if v, err := a.eng.APIKeys(a.ctx); err == nil {
		wruntime.EventsEmit(a.ctx, "keys", v)
	}
}

// ---------- Claude accounts ----------

func (a *App) ClaudeAccounts() ([]engine.ClaudeAccountView, error) {
	v, err := a.eng.ClaudeAccounts()
	if v == nil {
		v = []engine.ClaudeAccountView{}
	}
	return v, err
}

// AddClaudeAccount adds an account: with no token it runs the browser sign-in. use makes it
// the active account straight away.
func (a *App) AddClaudeAccount(label, token string, use bool) string {
	opts := engine.AddOptions{Use: use}
	if l := a.eng.ClaudeLocalLogin(); label == "" && token == "" && l != nil && l.AccountID == "" {
		opts.Expect = syncer.LocalAccount(paths.Home()) // most likely what the browser approves
	}
	return a.addClaudeAccount(label, token, opts)
}

// addLoginAccount adds the account a /login here just switched to, which the pool doesn't
// have: the browser approval opens by itself, and the account is used once it is added.
func (a *App) addLoginAccount(acct syncer.Account) {
	wruntime.EventsEmit(a.ctx, "claude:adding", acct.Email())
	a.addClaudeAccount("", "", engine.AddOptions{Use: true, Expect: acct})
}

func (a *App) addClaudeAccount(label, token string, opts engine.AddOptions) string {
	title := "Add Claude account"
	if label != "" {
		title += " " + label
	} else if opts.Expect != nil {
		title += " " + opts.Expect.Email()
	}
	return a.ops.start("claude-account", title, "", func(ctx context.Context, r events.Reporter) (any, error) {
		acct, err := a.eng.AddClaudeAccount(ctx, label, token, opts, r)
		a.emitClaude()
		if err != nil {
			return nil, err
		}
		// Switch right away if the active account is limited.
		if res, terr := a.eng.ClaudeTick(ctx, a.poll.publishedSessions(), r); terr == nil && res.Switched {
			a.announceSwitch(res)
		}
		a.emitClaude()
		return acct, nil
	})
}

func (a *App) RemoveClaudeAccount(id string) error {
	defer a.emitClaude()
	return a.eng.RemoveClaudeAccount(id)
}

// ClaudeAccountToken is an account's token, to show.
func (a *App) ClaudeAccountToken(id string) (string, error) { return a.eng.ClaudeAccountToken(id) }

// CopyClaudeAccountToken puts an account's token on the clipboard without passing it
// through the page.
func (a *App) CopyClaudeAccountToken(id string) error {
	t, err := a.eng.ClaudeAccountToken(id)
	if err != nil {
		return err
	}
	return wruntime.ClipboardSetText(a.ctx, t)
}

func (a *App) RenameClaudeAccount(id, label string) error {
	defer a.emitClaude()
	return a.eng.RenameClaudeAccount(id, label)
}

func (a *App) MoveClaudeAccount(id string, delta int) error {
	defer a.emitClaude()
	return a.eng.MoveClaudeAccount(id, delta)
}

func (a *App) SetClaudeAccountEnabled(id string, on bool) error {
	defer a.emitClaude()
	return a.eng.SetClaudeAccountEnabled(id, on)
}

func (a *App) SetClaudeAutoSwitch(on bool) error {
	defer a.emitClaude()
	return a.eng.SetClaudeAutoSwitch(on)
}

// ClaudeSource is where sessions get their login: "pool" (rotation) or "login" (this Mac's
// Claude Code login, switched with /login).
func (a *App) ClaudeSource() string {
	if s, _ := a.eng.Settings(); s.ClaudeFollowLogin() {
		return "login"
	}
	return "pool"
}

func (a *App) SetClaudeSource(source string) error {
	defer a.emitClaude()
	ctx, cancel := context.WithTimeout(a.ctx, 3*time.Minute)
	defer cancel()
	return a.eng.SetClaudeSource(ctx, source, nil)
}

// ClaudeLocalLogin is this Mac's Claude Code login and whether the pool has it.
func (a *App) ClaudeLocalLogin() *engine.LocalLogin { return a.eng.ClaudeLocalLogin() }

// SetClaudeStrategy picks "smart" (use what expires first) or "order" (the list order).
func (a *App) SetClaudeStrategy(strategy string) error {
	defer a.emitClaude()
	return a.eng.SetClaudeStrategy(strategy)
}

func (a *App) ClaudeStrategy() string {
	s, _ := a.eng.Settings()
	if s.ClaudeSmart() {
		return "smart"
	}
	return "order"
}

func (a *App) ClaudeAutoSwitch() bool {
	s, _ := a.eng.Settings()
	return s.ClaudeAutoOn()
}

// UseClaudeAccount makes an account active and signs every machine in with it.
func (a *App) UseClaudeAccount(id string) string {
	return a.ops.start("claude-use", "Switch Claude account", "", func(ctx context.Context, r events.Reporter) (any, error) {
		err := a.eng.UseClaudeAccount(ctx, id, r)
		a.emitClaude()
		return nil, err
	})
}

// CheckClaudeAccounts checks every account's usage, then switches if the active one is limited.
func (a *App) CheckClaudeAccounts() string {
	return a.ops.start("claude-check", "Check Claude accounts", "", func(ctx context.Context, r events.Reporter) (any, error) {
		events.Stepf(r, "Checking usage")
		if _, err := a.eng.CheckClaudeAccounts(ctx, r); err != nil {
			return nil, err
		}
		a.emitClaude()
		res, err := a.eng.ClaudeTick(ctx, a.poll.publishedSessions(), r)
		if res.Switched {
			a.announceSwitch(res)
		}
		a.emitClaude()
		return res, err
	})
}

func (a *App) emitClaude() {
	if v, err := a.eng.ClaudeAccounts(); err == nil && a.ctx != nil {
		wruntime.EventsEmit(a.ctx, "claude:accounts", v)
	}
}

// activeAccountName is the name of the Claude account machines use ("" when none).
func (a *App) activeAccountName() string {
	views, err := a.eng.ClaudeAccounts()
	if err != nil {
		return ""
	}
	for _, v := range views {
		if v.Active {
			if v.Account.Label != "" {
				return v.Account.Label
			}
			return v.Account.Email
		}
	}
	return ""
}

// announceFollow says sessions moved to the account a /login on this computer chose.
func (a *App) announceFollow(to string) {
	notify("Sessions now use "+to, "Claude Code on this Mac signed in to it with /login.")
	wruntime.EventsEmit(a.ctx, "claude:switched", engine.TickResult{Switched: true, To: to, Followed: to})
}

func (a *App) announceSwitch(res engine.TickResult) {
	body := fmt.Sprintf("%s: %s.", res.From, res.Reason)
	if res.Restarted > 0 {
		body += fmt.Sprintf(" Resumed %d session(s).", res.Restarted)
	}
	notify("Machines now use "+res.To, body)
	wruntime.EventsEmit(a.ctx, "claude:switched", res)
}

func (a *App) MintClaudeToken() string {
	return a.ops.start("claude-token", "Create Claude token", "", func(ctx context.Context, r events.Reporter) (any, error) {
		acct := syncer.LocalAccount(paths.Home())
		if acct == nil {
			return nil, errors.New("Claude Code on this computer isn't signed in; run `claude` and log in first")
		}
		events.Stepf(r, "Approve the Claude sign-in in your browser")
		_, err := syncer.Token(ctx, acct, true, true)
		if err == nil {
			events.Donef(r, "Token saved for %s", acct.Email())
		}
		return nil, err
	})
}

func (a *App) SetClaudeToken(token string) error {
	acct := syncer.LocalAccount(paths.Home())
	if acct == nil {
		return errors.New("Claude Code on this computer isn't signed in")
	}
	return syncer.SetToken(acct, token)
}

// ---------- folders ----------

func (a *App) Links() ([]*model.Link, error) {
	l, err := a.eng.Links()
	if l == nil {
		l = []*model.Link{}
	}
	return l, err
}

func (a *App) AddLink(l model.Link) (*model.Link, error) { return a.eng.AddLink(l) }

func (a *App) RemoveLink(id string) error {
	a.SetLinkWatch(id, false)
	return a.eng.RemoveLink(id)
}

func (a *App) RunLink(id string) string {
	return a.ops.start("link", "Copy folder", "", func(ctx context.Context, r events.Reporter) (any, error) {
		err := a.eng.RunLink(ctx, id, r)
		wruntime.EventsEmit(a.ctx, "links", nil)
		return nil, err
	})
}

// SetLinkWatch starts or stops pushing a link on every local change.
func (a *App) SetLinkWatch(id string, on bool) error {
	a.watchMu.Lock()
	defer a.watchMu.Unlock()
	if stop, ok := a.watches[id]; ok && !on {
		stop()
		delete(a.watches, id)
	}
	_ = a.eng.UpdateLink(id, func(l *model.Link) { l.Watch = on })
	if !on {
		wruntime.EventsEmit(a.ctx, "watch", map[string]any{"id": id, "on": false})
		return nil
	}
	if _, ok := a.watches[id]; ok {
		return nil
	}
	ctx, cancel := context.WithCancel(a.ctx)
	a.watches[id] = cancel
	go func() {
		r := events.Func(func(e events.Event) {
			wruntime.EventsEmit(a.ctx, "watch", map[string]any{"id": id, "on": true, "event": e})
		})
		err := a.eng.WatchLinks(ctx, []string{id}, r)
		a.watchMu.Lock()
		delete(a.watches, id)
		a.watchMu.Unlock()
		msg := ""
		if err != nil {
			msg = err.Error()
		}
		wruntime.EventsEmit(a.ctx, "watch", map[string]any{"id": id, "on": false, "error": msg})
	}()
	return nil
}

// WatchedLinks lists links being watched right now.
func (a *App) WatchedLinks() []string {
	a.watchMu.Lock()
	defer a.watchMu.Unlock()
	out := []string{}
	for id := range a.watches {
		out = append(out, id)
	}
	sort.Strings(out)
	return out
}

func (a *App) Push(name, local, remote string, o folders.Options) string {
	return a.ops.start("push", "Push to "+name, name, func(ctx context.Context, r events.Reporter) (any, error) {
		return nil, a.eng.Push(ctx, name, local, remote, o, r)
	})
}

func (a *App) Pull(name, remote, local string, o folders.Options) string {
	return a.ops.start("pull", "Pull from "+name, name, func(ctx context.Context, r events.Reporter) (any, error) {
		return nil, a.eng.Pull(ctx, name, remote, local, o, r)
	})
}

func (a *App) Clone(name, repo, dir string) string {
	return a.ops.start("clone", "Clone "+repo, name, func(ctx context.Context, r events.Reporter) (any, error) {
		return a.eng.Clone(ctx, name, repo, dir, r)
	})
}

// PickFolder shows the native folder picker.
func (a *App) PickFolder(title string) (string, error) {
	return wruntime.OpenDirectoryDialog(a.ctx, wruntime.OpenDialogOptions{Title: title, DefaultDirectory: paths.Home(), CanCreateDirectories: true})
}

// PickFile shows the native file picker (for SSH keys).
func (a *App) PickFile(title string) (string, error) {
	return wruntime.OpenFileDialog(a.ctx, wruntime.OpenDialogOptions{Title: title, DefaultDirectory: paths.Home(), ShowHiddenFiles: true})
}

// ---------- settings ----------

// SettingsView is config.Settings with defaults resolved, for forms.
type SettingsView struct {
	DefaultProvider string   `json:"defaultProvider"`
	RemoteUser      string   `json:"remoteUser"`
	Tailscale       bool     `json:"tailscale"`
	Docker          bool     `json:"docker"`
	AutoTmux        bool     `json:"autoTmux"`
	Terminal        string   `json:"terminal"`
	SyncInterval    int      `json:"syncInterval"`
	SyncPaths       []string `json:"syncPaths"`
	SkipCredentials []string `json:"skipCredentials"`
	SkipMCP         []string `json:"skipMCP"`
}

func nonNil(s []string) []string {
	if s == nil {
		return []string{}
	}
	return s
}

func (a *App) Settings() (SettingsView, error) {
	s, err := a.eng.Settings()
	if err != nil {
		return SettingsView{}, err
	}
	return SettingsView{
		DefaultProvider: s.DefaultProvider, RemoteUser: s.User(), Tailscale: s.TailscaleOn(), Docker: s.DockerOn(),
		AutoTmux: s.AutoTmuxOn(), Terminal: s.Terminal, SyncInterval: int(s.Interval().Seconds()),
		SyncPaths: nonNil(s.SyncPaths), SkipCredentials: nonNil(s.SkipCredentials), SkipMCP: nonNil(s.SkipMCP),
	}, nil
}

func (a *App) SaveSettings(v SettingsView) error {
	return a.eng.UpdateSettings(func(s *config.Settings) {
		s.DefaultProvider = v.DefaultProvider
		s.RemoteUser = ""
		if v.RemoteUser != "" && v.RemoteUser != config.LocalUser() {
			s.RemoteUser = v.RemoteUser
		}
		ts, dk, tm := v.Tailscale, v.Docker, v.AutoTmux
		s.Tailscale, s.Docker, s.AutoTmux = &ts, &dk, &tm
		s.Terminal = v.Terminal
		s.SyncInterval = v.SyncInterval
		s.SyncPaths = clean(v.SyncPaths)
		s.SkipCredentials = clean(v.SkipCredentials)
		s.SkipMCP = clean(v.SkipMCP)
	})
}

func clean(in []string) []string {
	var out []string
	for _, s := range in {
		if s = strings.TrimSpace(s); s != "" {
			out = append(out, s)
		}
	}
	return out
}

// ---------- sessions ----------

// SessionsView is the latest poll: sessions plus machines that couldn't be reached.
type SessionsView struct {
	Sessions []engine.Session  `json:"sessions"`
	Errors   map[string]string `json:"errors"`
	At       time.Time         `json:"at"`
}

// Sessions returns the latest poll (and triggers a fresh one).
// Sessions is what is known right now (at once: a first paint doesn't wait on the machines),
// with a fresh look started behind it; what that finds arrives as "sessions" events.
func (a *App) Sessions() SessionsView {
	go func() {
		if a.poll.primary() {
			go a.poll.refreshLocal(a.ctx)
			a.poll.refresh(a.ctx)
		} else {
			a.poll.follow(a.ctx)
		}
	}()
	return a.poll.current()
}

func (a *App) NewSession(machine string, o engine.SessionOptions) (engine.Session, error) {
	ctx, cancel := context.WithTimeout(a.ctx, 30*time.Second)
	defer cancel()
	s, err := a.eng.NewSession(ctx, machine, o)
	if err == nil {
		go a.refreshSessions(machine)
	}
	return s, err
}

func (a *App) KillSession(machine, session string) error {
	ctx, cancel := context.WithTimeout(a.ctx, 20*time.Second)
	defer cancel()
	err := a.eng.KillSession(ctx, machine, session)
	go a.refreshSessions(machine)
	return err
}

// refreshSessions polls the part of the session list a change on machine touched.
func (a *App) refreshSessions(machine string) {
	if engine.IsLocal(machine) {
		a.poll.refreshLocal(a.ctx)
		return
	}
	a.poll.refresh(a.ctx)
}

// ---------- terminals ----------

// OpenTerminal attaches a terminal tab to a machine session (empty session: login shell).
func (a *App) OpenTerminal(machine, session string, cols, rows int) (term.Info, error) {
	return a.OpenSessionTerminal(machine, session, engine.AttachOptions{}, cols, rows)
}

// OpenSessionTerminal attaches to a session, creating it in dir first if it doesn't exist
// (and starting Claude Code in it when claude is set). It is one command, so a new pane
// "like this one" opens as fast as an attach. machine is a machine's name, or
// engine.LocalMachine for a session on this computer. The options say how to make the
// session when it isn't there: the folder, Claude Code afresh, or a lost Claude session
// brought back with its conversation.
func (a *App) OpenSessionTerminal(machine, session string, o engine.AttachOptions, cols, rows int) (term.Info, error) {
	if a.terms == nil {
		return term.Info{}, errors.New("terminal server failed to start")
	}
	local := engine.IsLocal(machine)
	var args []string
	var err error
	if local {
		args, err = a.eng.LocalAttachArgs(session, o)
	} else {
		args, err = a.eng.AttachArgsIn(machine, session, o)
	}
	a.paneOpening(machine, session)
	if err != nil {
		// A machine that stops when idle is started instead, and the pane keeps trying.
		return term.Info{}, a.wakeOnAttach(machine, session, err)
	}
	title := machine
	if session != "" {
		title = session
	}
	spec := term.Spec{Args: args, Title: title, Cols: cols, Rows: rows}
	if local {
		spec.Dir = paths.Home()
	} else {
		// The machine's one shared connection first (made once, however many panes ask at
		// the same moment); the pane's ssh then rides on it instead of making its own.
		rc, cancel := context.WithTimeout(a.ctx, 8*time.Second)
		a.eng.ReadyTerminals(rc, machine)
		cancel()
	}
	info, err := a.terms.Start(spec)
	if !local {
		go a.eng.WarmTerminals(a.ctx, machine) // the next pane on this machine opens faster
	}
	if err == nil && (o.Dir != "" || o.Claude || o.Resume != "") {
		go func() { // show the new session in the lists without waiting for the next poll
			time.Sleep(1200 * time.Millisecond)
			a.refreshSessions(machine)
		}()
	}
	return info, err
}

// OpenLocalTerminal opens a shell on this computer.
func (a *App) OpenLocalTerminal(cols, rows int) (term.Info, error) {
	return a.OpenLocalTerminalIn("", false, cols, rows)
}

// OpenLocalTerminalIn opens a shell on this computer in dir ("" = home), running Claude
// Code first when claude is set; leaving Claude drops to the shell.
func (a *App) OpenLocalTerminalIn(dir string, claude bool, cols, rows int) (term.Info, error) {
	if a.terms == nil {
		return term.Info{}, errors.New("terminal server failed to start")
	}
	shell := os.Getenv("SHELL")
	if shell == "" && runtime.GOOS != "windows" {
		shell = "/bin/zsh"
	}
	args := []string{shell, "-l"}
	if claude {
		args = []string{shell, "-l", "-i", "-c", "claude; exec " + shell + " -l"}
	}
	if runtime.GOOS == "windows" {
		args = []string{"powershell.exe", "-NoLogo"}
		if p, err := exec.LookPath("pwsh.exe"); err == nil {
			args = []string{p, "-NoLogo"}
		}
		if claude {
			args = append(args, "-NoExit", "-Command", "claude")
		}
	}
	dir = paths.Expand(dir)
	if st, err := os.Stat(dir); dir == "" || err != nil || !st.IsDir() {
		dir = paths.Home()
	}
	return a.terms.Start(term.Spec{Args: args, Title: "local", Dir: dir, Cols: cols, Rows: rows})
}

// TerminalInfo reports a local terminal's folder and what runs in it (empty if unknown).
func (a *App) TerminalInfo(id string) term.Probe {
	if a.terms == nil {
		return term.Probe{}
	}
	p, _ := a.terms.Probe(id)
	return p
}

// ---------- windows ----------

// WindowInfo identifies this window among the app's instances.
type WindowInfo struct {
	ID      string `json:"id"`      // "main" for the first window
	Primary bool   `json:"primary"` // runs the once-only background work
	Count   int    `json:"count"`   // windows open right now
	// Headless: the app's own window is hidden (SKY_HEADLESS) and a browser drives the UI.
	Headless bool `json:"headless"`
	// Forgotten: windows closed for good whose tabs are still in the page's storage, for
	// the page to clear (then WindowsCleared).
	Forgotten []string `json:"forgotten"`
}

func (a *App) WindowInfo() WindowInfo {
	info := WindowInfo{ID: a.win.id, Primary: a.win.primary.Load(), Count: len(a.win.pids()), Headless: os.Getenv("SKY_HEADLESS") != "", Forgotten: []string{}}
	if restores() {
		info.Forgotten = append(info.Forgotten, readSaved().Forgotten...)
	}
	return info
}

// WindowsCleared: the page cleared what these forgotten windows left in its storage.
func (a *App) WindowsCleared(ids []string) {
	updateSaved(func(s *savedWindows) {
		s.Forgotten = slices.DeleteFunc(s.Forgotten, func(x string) bool { return slices.Contains(ids, x) })
	})
}

// NewWindow opens another Lungo window.
func (a *App) NewWindow() error { return a.win.open("") }

// NewWindowWith opens another window with panes taken from this one (a saved layout).
func (a *App) NewWindowWith(layout string) error { return a.win.openWith(layout) }

// WindowLayout is what this window opens with: panes handed to it, else its own tabs from
// last time ("" when none).
func (a *App) WindowLayout() string { return a.win.layout() }

// SaveWindowLayout keeps this window's tabs and splits for next time.
func (a *App) SaveWindowLayout(layout string) error {
	if !restores() && os.Getenv("SKY_HEADLESS") != "" {
		return nil // a hidden dev window keeps nothing
	}
	return a.win.saveLayout(layout)
}

// WindowSessions tells the app which sessions this window's panes show ("machine/session"):
// another window asked to show one of them sends the user here, and shells any window
// points at are never tidied away.
func (a *App) WindowSessions(keys []string) {
	a.win.setSessions(keys)
	keep := map[string][]string{}
	for _, k := range keys {
		if m, s, ok := strings.Cut(k, "/"); ok && strings.HasPrefix(s, engine.ShellPrefix) {
			keep[m] = append(keep[m], s)
		}
	}
	a.poll.mu.Lock()
	a.poll.keep = keep
	a.poll.mu.Unlock()
}

// FocusSession brings forward the other window that shows a session and has it show it
// there. False when no other window has it open.
func (a *App) FocusSession(machine, session string) bool {
	pid := a.win.holder(machine + "/" + session)
	if pid == 0 || a.win.ask(pid, "show", machine+"/"+session) != nil {
		return false
	}
	_ = activate(pid)
	return true
}

// TakeSession has the other window that shows a session let it go, for this window to show
// it instead. False when no other window has it open.
func (a *App) TakeSession(machine, session string) bool {
	pid := a.win.holder(machine + "/" + session)
	return pid != 0 && a.win.ask(pid, "release", machine+"/"+session) == nil
}

// NextWindow brings the next Lungo window to the front.
func (a *App) NextWindow() error { return a.win.next() }

// CloseShell tidies up after a shell pane: its tmux session goes away unless something is
// still running in it.
func (a *App) CloseShell(machine, session string) {
	go func() {
		ctx, cancel := context.WithTimeout(a.ctx, 20*time.Second)
		defer cancel()
		_ = a.eng.CloseShell(ctx, machine, session)
	}()
}

func (a *App) CloseTerminal(id string) {
	if a.terms != nil {
		a.terms.Close(id)
	}
}

// Terminal returns a terminal's info (to re-attach after a reload).
func (a *App) Terminal(id string) (term.Info, error) {
	if a.terms == nil {
		return term.Info{}, errors.New("terminal server failed to start")
	}
	if t, ok := a.terms.Get(id); ok {
		return t, nil
	}
	return term.Info{}, errors.New("terminal is gone")
}

// Notify shows a native notification (used by the UI for rare events).
func (a *App) Notify(title, body string) { notify(title, body) }
