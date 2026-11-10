package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gofrs/flock"
	wruntime "github.com/wailsapp/wails/v2/pkg/runtime"

	"skybuild/internal/paths"
)

// Updates: Lungo looks for a newer release on GitHub, downloads it in the background,
// checks it is signed by the same developer as the running app, and swaps it in when the
// app quits, or at once on "Restart to update". Sessions run in tmux and every window comes
// back, so a restart costs a second.
//
// One window (the primary) checks and downloads; every window shows the state, which lives
// in ~/.skybuild/updates/state.json. The update to install waits in ~/.skybuild/updates/ready.

// updateFeed is the newest release's manifest (scripts/release.sh writes it).
const updateFeed = "https://github.com/owehx/lungo/releases/latest/download/latest.json"

func feedURL() string {
	if v := os.Getenv("SKY_UPDATE_FEED"); v != "" {
		return v
	}
	return updateFeed
}

type releaseManifest struct {
	Version string        `json:"version"`
	Notes   string        `json:"notes,omitempty"`
	Mac     *releaseAsset `json:"mac,omitempty"`
}

type releaseAsset struct {
	URL    string `json:"url"`
	SHA256 string `json:"sha256"`
	Size   int64  `json:"size"`
}

// UpdateInfo is what the windows show about updates.
type UpdateInfo struct {
	Current   string    `json:"current"`
	Latest    string    `json:"latest,omitempty"`
	State     string    `json:"state"` // "" (up to date) | checking | downloading | ready | error | off (a build that can't update itself)
	Progress  float64   `json:"progress,omitempty"`
	Notes     string    `json:"notes,omitempty"`
	Error     string    `json:"error,omitempty"`
	CheckedAt time.Time `json:"checkedAt,omitzero"`
	Auto      bool      `json:"auto"`
	Why       string    `json:"why,omitempty"` // why this build can't update itself
}

func updatesDir() string      { return filepath.Join(paths.Root(), "updates") }
func readyApp() string        { return filepath.Join(updatesDir(), "ready", "Lungo.app") }
func updateStateFile() string { return filepath.Join(updatesDir(), "state.json") }

// ---------- the running app ----------

var versionOnce = sync.OnceValue(func() string {
	if Version != "dev" && Version != "" {
		return strings.TrimPrefix(Version, "v")
	}
	if b, ok := appBundle(); ok {
		if v := plistValue(filepath.Join(b, "Contents", "Info.plist"), "CFBundleShortVersionString"); v != "" {
			return v
		}
	}
	return "dev"
})

// appVersion is this build's version ("dev" for a development build).
func appVersion() string { return versionOnce() }

func plistValue(plist, key string) string {
	out, err := exec.Command("/usr/bin/plutil", "-extract", key, "raw", "-o", "-", plist).Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}

var teamID = regexp.MustCompile(`(?m)^TeamIdentifier=(\S+)$`)

// signer is the developer (team) an app is signed by, "" when none (ad hoc or unsigned).
func signer(app string) string {
	out, _ := exec.Command("/usr/bin/codesign", "-dv", app).CombinedOutput()
	if m := teamID.FindSubmatch(out); m != nil && string(m[1]) != "not" {
		return string(m[1])
	}
	return ""
}

// selfUpdatable says whether this build can replace itself, and why not.
var selfUpdatable = sync.OnceValues(func() (bool, string) {
	if runtime.GOOS != "darwin" {
		return false, "Updates come from github.com/owehx/lungo/releases on this system."
	}
	if appVersion() == "dev" {
		return false, "A development build doesn't update itself."
	}
	b, ok := appBundle()
	if !ok {
		return false, "Not running from an app bundle."
	}
	if signer(b) == "" {
		return false, "This build isn't signed by a developer, so an update couldn't be checked against it."
	}
	if !canReplace(b) {
		return false, "Lungo can't write to " + filepath.Dir(b) + "."
	}
	return true, ""
})

// newer reports whether version a is newer than b ("0.1.10" > "0.1.9").
func newer(a, b string) bool {
	pa, pb := versionParts(a), versionParts(b)
	if pa == nil || pb == nil {
		return false
	}
	for i := range max(len(pa), len(pb)) {
		x, y := 0, 0
		if i < len(pa) {
			x = pa[i]
		}
		if i < len(pb) {
			y = pb[i]
		}
		if x != y {
			return x > y
		}
	}
	return false
}

func versionParts(v string) []int {
	v = strings.TrimPrefix(strings.TrimSpace(v), "v")
	if v == "" {
		return nil
	}
	var out []int
	for _, p := range strings.Split(v, ".") {
		n, err := strconv.Atoi(p)
		if err != nil {
			return nil
		}
		out = append(out, n)
	}
	return out
}

// ---------- shared state ----------

type updateState struct {
	Latest    string    `json:"latest,omitempty"`
	State     string    `json:"state"`
	Progress  float64   `json:"progress,omitempty"`
	Notes     string    `json:"notes,omitempty"`
	Error     string    `json:"error,omitempty"`
	CheckedAt time.Time `json:"checkedAt,omitzero"`
	Ready     string    `json:"ready,omitempty"` // the version waiting in ready/
}

func readUpdateState() updateState {
	var s updateState
	if b, err := os.ReadFile(updateStateFile()); err == nil {
		_ = json.Unmarshal(b, &s)
	}
	// What is waiting to be installed is what's on disk.
	if s.Ready != "" {
		if v := readyVersion(); v != s.Ready {
			s.Ready = ""
			if s.State == "ready" {
				s.State = ""
			}
		}
	}
	return s
}

// readyVersion is the version of the update waiting in ready/ ("" when none), read again
// only when its Info.plist changes: every window asks every few seconds.
var readyCache struct {
	sync.Mutex
	mod time.Time
	v   string
}

func readyVersion() string {
	plist := filepath.Join(readyApp(), "Contents", "Info.plist")
	fi, err := os.Stat(plist)
	if err != nil {
		return ""
	}
	readyCache.Lock()
	defer readyCache.Unlock()
	if !fi.ModTime().Equal(readyCache.mod) {
		readyCache.mod, readyCache.v = fi.ModTime(), plistValue(plist, "CFBundleShortVersionString")
	}
	return readyCache.v
}

func writeUpdateState(s updateState) {
	_ = os.MkdirAll(updatesDir(), 0o700)
	b, _ := json.Marshal(s)
	tmp := updateStateFile() + ".tmp"
	if os.WriteFile(tmp, b, 0o600) == nil {
		_ = os.Rename(tmp, updateStateFile())
	}
}

func autoUpdate() bool {
	b, err := os.ReadFile(filepath.Join(updatesDir(), "auto"))
	return err != nil || strings.TrimSpace(string(b)) != "0"
}

func (a *App) updateInfo() UpdateInfo {
	info := UpdateInfo{Current: appVersion(), Auto: autoUpdate()}
	if ok, why := selfUpdatable(); !ok {
		info.State, info.Why = "off", why
	}
	s := readUpdateState()
	info.Latest, info.Notes, info.CheckedAt = s.Latest, s.Notes, s.CheckedAt
	if info.State == "off" {
		return info
	}
	switch {
	case s.Ready != "" && newer(s.Ready, info.Current):
		info.State, info.Latest = "ready", s.Ready
	case s.State == "checking" || s.State == "downloading" || s.State == "error":
		info.State, info.Progress, info.Error = s.State, s.Progress, s.Error
	}
	return info
}

// ---------- checking and downloading ----------

func updateLock() *flock.Flock {
	_ = os.MkdirAll(updatesDir(), 0o700)
	return flock.New(filepath.Join(updatesDir(), "lock"))
}

// checkForUpdate looks for a newer release and downloads it. One at a time across windows.
func (a *App) checkForUpdate(ctx context.Context) error {
	if ok, why := selfUpdatable(); !ok {
		return errors.New(why)
	}
	lock := updateLock()
	if ok, _ := lock.TryLock(); !ok {
		return nil // another window is on it
	}
	defer lock.Unlock()
	s := readUpdateState()
	set := func(f func(*updateState)) {
		f(&s)
		writeUpdateState(s)
		a.emitUpdate()
	}
	set(func(s *updateState) { s.State, s.Error = "checking", "" })
	m, err := fetchManifest(ctx)
	if err != nil {
		set(func(s *updateState) {
			s.State, s.Error, s.CheckedAt = "error", "Couldn't reach GitHub: "+err.Error(), time.Now()
		})
		return err
	}
	set(func(s *updateState) { s.Latest, s.Notes, s.CheckedAt = m.Version, m.Notes, time.Now() })
	if !newer(m.Version, appVersion()) {
		set(func(s *updateState) { s.State = "" })
		return nil
	}
	if s.Ready == m.Version {
		set(func(s *updateState) { s.State = "ready" })
		return nil
	}
	if m.Mac == nil || m.Mac.URL == "" {
		set(func(s *updateState) { s.State, s.Error = "error", "Release "+m.Version+" has no Mac download." })
		return errors.New(s.Error)
	}
	set(func(s *updateState) { s.State, s.Progress = "downloading", 0 })
	last := time.Time{}
	err = downloadUpdate(ctx, m, func(p float64) {
		if time.Since(last) > 400*time.Millisecond {
			last = time.Now()
			set(func(s *updateState) { s.Progress = p })
		}
	})
	if err != nil {
		set(func(s *updateState) { s.State, s.Error, s.Progress = "error", err.Error(), 0 })
		return err
	}
	set(func(s *updateState) { s.State, s.Ready, s.Progress = "ready", m.Version, 1 })
	return nil
}

func fetchManifest(ctx context.Context) (releaseManifest, error) {
	var m releaseManifest
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, feedURL(), nil)
	req.Header.Set("User-Agent", "Lungo/"+appVersion())
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return m, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return m, fmt.Errorf("%s", resp.Status)
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&m); err != nil {
		return m, err
	}
	if versionParts(m.Version) == nil {
		return m, fmt.Errorf("the release manifest has no version")
	}
	m.Version = strings.TrimPrefix(m.Version, "v")
	return m, nil
}

// downloadUpdate fetches the release's app, checks it, and leaves it in ready/.
func downloadUpdate(ctx context.Context, m releaseManifest, progress func(float64)) error {
	work := filepath.Join(updatesDir(), "work")
	_ = os.RemoveAll(work)
	if err := os.MkdirAll(work, 0o700); err != nil {
		return err
	}
	defer os.RemoveAll(work)
	ctx, cancel := context.WithTimeout(ctx, 20*time.Minute)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, m.Mac.URL, nil)
	req.Header.Set("User-Agent", "Lungo/"+appVersion())
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return fmt.Errorf("download: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("download: %s", resp.Status)
	}
	zip := filepath.Join(work, "Lungo.zip")
	f, err := os.Create(zip)
	if err != nil {
		return err
	}
	h := sha256.New()
	total := m.Mac.Size
	if total <= 0 {
		total = resp.ContentLength
	}
	var got int64
	buf := make([]byte, 256<<10)
	for {
		n, rerr := resp.Body.Read(buf)
		if n > 0 {
			if _, err := f.Write(buf[:n]); err != nil {
				f.Close()
				return err
			}
			h.Write(buf[:n])
			got += int64(n)
			if total > 0 {
				progress(float64(got) / float64(total))
			}
		}
		if rerr == io.EOF {
			break
		}
		if rerr != nil {
			f.Close()
			return fmt.Errorf("download: %w", rerr)
		}
	}
	if err := f.Close(); err != nil {
		return err
	}
	if sum := hex.EncodeToString(h.Sum(nil)); !strings.EqualFold(sum, m.Mac.SHA256) {
		return fmt.Errorf("the download is damaged (its checksum doesn't match)")
	}
	unpacked := filepath.Join(work, "app")
	if out, err := exec.Command("/usr/bin/ditto", "-x", "-k", zip, unpacked).CombinedOutput(); err != nil {
		return fmt.Errorf("unpack: %s", strings.TrimSpace(string(out)))
	}
	app := filepath.Join(unpacked, "Lungo.app")
	if err := checkUpdate(app, m.Version); err != nil {
		return err
	}
	ready := readyApp()
	_ = os.RemoveAll(filepath.Dir(ready))
	if err := os.MkdirAll(filepath.Dir(ready), 0o700); err != nil {
		return err
	}
	return os.Rename(app, ready)
}

// checkUpdate makes sure a downloaded app is Lungo, at the version promised, signed by the
// developer who signed the running app, and intact.
func checkUpdate(app, version string) error {
	self, _ := appBundle()
	info := filepath.Join(app, "Contents", "Info.plist")
	if id, want := plistValue(info, "CFBundleIdentifier"), plistValue(filepath.Join(self, "Contents", "Info.plist"), "CFBundleIdentifier"); id == "" || id != want {
		return fmt.Errorf("the download isn't Lungo (%q)", id)
	}
	if v := plistValue(info, "CFBundleShortVersionString"); v != version {
		return fmt.Errorf("the download is version %q, not %s", v, version)
	}
	if out, err := exec.Command("/usr/bin/codesign", "--verify", "--deep", "--strict", app).CombinedOutput(); err != nil {
		return fmt.Errorf("the download's signature doesn't check out: %s", strings.TrimSpace(string(out)))
	}
	if got, want := signer(app), signer(self); got == "" || got != want {
		return fmt.Errorf("the download is signed by %q, not by Lungo's developer (%s)", got, want)
	}
	return nil
}

// updateLoop: the primary window checks soon after starting and every few hours; every
// window passes on changes made by the others.
func (a *App) updateLoop(ctx context.Context) {
	check := time.NewTimer(30 * time.Second)
	every := time.NewTicker(3 * time.Hour)
	look := time.NewTicker(3 * time.Second)
	defer check.Stop()
	defer every.Stop()
	defer look.Stop()
	seen := a.updateInfo()
	for {
		select {
		case <-ctx.Done():
			return
		case <-check.C:
		case <-every.C:
		case <-look.C:
			if now := a.updateInfo(); now != seen {
				seen = now
				wruntime.EventsEmit(ctx, "update", now)
			}
			continue
		}
		if a.win.primary.Load() && autoUpdate() {
			_ = a.checkForUpdate(ctx)
		}
	}
}

func (a *App) emitUpdate() {
	if a.ctx != nil {
		wruntime.EventsEmit(a.ctx, "update", a.updateInfo())
	}
}

// ---------- bound to the UI ----------

// UpdateInfo says which version this is and whether a newer one is coming.
func (a *App) UpdateInfo() UpdateInfo { return a.updateInfo() }

// CheckForUpdates looks for a newer release now (and downloads it).
func (a *App) CheckForUpdates() UpdateInfo {
	ctx, cancel := context.WithTimeout(a.ctx, 25*time.Minute)
	defer cancel()
	_ = a.checkForUpdate(ctx)
	return a.updateInfo()
}

// SetAutoUpdate turns checking and downloading in the background on or off.
func (a *App) SetAutoUpdate(on bool) error {
	_ = os.MkdirAll(updatesDir(), 0o700)
	v := "1"
	if !on {
		v = "0"
	}
	err := os.WriteFile(filepath.Join(updatesDir(), "auto"), []byte(v), 0o600)
	a.emitUpdate()
	return err
}

// RestartToUpdate installs the downloaded update and opens Lungo again: every window
// quits, the new app takes the old one's place, and the windows come back.
func (a *App) RestartToUpdate() error {
	if a.updateInfo().State != "ready" {
		return errors.New("no update is ready to install")
	}
	if err := a.startInstaller(true); err != nil {
		return err
	}
	a.win.updating.Store(true)
	for pid := range a.win.others() {
		askToQuit(pid)
	}
	go func() {
		time.Sleep(200 * time.Millisecond)
		wruntime.Quit(a.ctx)
	}()
	return nil
}

// installOnQuit: quitting the app with an update waiting installs it on the way out, so
// the next start is the new version.
func (a *App) installOnQuit() {
	if a.win.updating.Load() || a.updateInfo().State != "ready" {
		return
	}
	a.win.updating.Store(true)
	_ = a.startInstaller(false)
}
