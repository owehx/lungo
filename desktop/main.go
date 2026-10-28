// Lungo desktop: the machine manager and Claude Code terminal, on the same engine as the
// `sky` CLI.
package main

import (
	"embed"
	"log"
	"os"
	"runtime"
	"strings"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/menu"
	"github.com/wailsapp/wails/v2/pkg/menu/keys"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
	"github.com/wailsapp/wails/v2/pkg/options/linux"
	"github.com/wailsapp/wails/v2/pkg/options/mac"
	"github.com/wailsapp/wails/v2/pkg/options/windows"
	wruntime "github.com/wailsapp/wails/v2/pkg/runtime"

	"skybuild/internal/osx"
)

//go:embed all:frontend/dist
var assets embed.FS

//go:embed build/appicon.png
var icon []byte

func main() {
	if len(os.Args) > 1 && os.Args[1] == "--install-update" {
		installMain(os.Args[2:]) // the helper that puts an update in place (update.go)
		return
	}
	osx.FixLocale() // before anything starts a program: tmux reads it
	keepErrors()
	stacksOnSignal()
	app := NewApp()
	mainApp = app
	bind := []interface{}{app}
	headless := os.Getenv("SKY_HEADLESS") != ""
	if headless {
		bind = append(bind, &Debug{a: app}) // lets dev checks drive the hidden window
		neverActivate()
	}
	// The window opens where it was left, at the size it was left; the first time ever it
	// fills the screen.
	width, height, state := 1320, 840, options.Normal
	if app.keepsFrame() {
		f, ok := startFrame(app.win.id)
		switch {
		case ok && f.Fullscreen:
			state = options.Fullscreen
		case runtime.GOOS != "darwin" && (!ok || f.Maximised): // on macOS the frame itself says it
			state = options.Maximised
		}
		if ok {
			width, height = f.W, f.H
		}
		launchFrame(f, ok)
	}
	shown := iconPNG(chosenIcon()) // About and the Linux window icon follow the pick
	err := wails.Run(&options.App{
		Title:            "Lungo",
		StartHidden:      headless, // dev checks drive the UI from a headless browser
		Width:            width,
		Height:           height,
		WindowStartState: state,
		MinWidth:         940,
		MinHeight:        580,
		AssetServer:      &assetserver.Options{Assets: assets},
		BackgroundColour: &options.RGBA{R: 13, G: 13, B: 15, A: 0},
		Menu:             appMenu(app),
		OnStartup:        app.startup,
		OnDomReady:       app.domReady,
		OnBeforeClose:    app.beforeClose,
		OnShutdown:       app.shutdown,
		Bind:             bind,
		Mac: &mac.Options{
			OnUrlOpen:            app.openedWith, // a lungo:// invite clicked anywhere
			TitleBar:             mac.TitleBarHiddenInset(),
			WebviewIsTransparent: true,
			WindowIsTranslucent:  true,
			About: &mac.AboutInfo{
				Title:   "Lungo",
				Message: "Machines for your Claude sessions.",
				Icon:    shown,
			},
		},
		Windows: &windows.Options{
			Theme:        windows.SystemDefault,
			BackdropType: windows.Mica,
		},
		Linux: &linux.Options{Icon: shown, ProgramName: "lungo", WindowIsTranslucent: false},
	})
	if err != nil {
		log.Fatal(err)
	}
}

// appMenu gives the native shortcuts: Edit (so copy/paste work in the webview) and the
// session shortcuts, which fire even while a terminal has focus.
func appMenu(app *App) *menu.Menu {
	m := menu.NewMenu()
	if runtime.GOOS == "darwin" {
		m.Append(menu.AppMenu())
	}
	m.Append(menu.EditMenu())

	// ⌘ on macOS; Ctrl+Shift elsewhere so plain Ctrl keys still reach the shell. The
	// "shifted" variant is ⇧⌘ on macOS and Ctrl+Alt elsewhere.
	mac := runtime.GOOS == "darwin"
	acc := func(k string) *keys.Accelerator {
		if mac {
			return keys.CmdOrCtrl(k)
		}
		return keys.Combo(k, keys.CmdOrCtrlKey, keys.ShiftKey)
	}
	acc2 := func(k string) *keys.Accelerator {
		if mac {
			return keys.Combo(k, keys.CmdOrCtrlKey, keys.ShiftKey)
		}
		return keys.Combo(k, keys.CmdOrCtrlKey, keys.OptionOrAltKey)
	}
	emit := func(name string, data ...interface{}) func(*menu.CallbackData) {
		return func(*menu.CallbackData) {
			wruntime.EventsEmit(app.ctx, "menu", append([]interface{}{name}, data...)...)
		}
	}
	s := m.AddSubmenu("Session")
	s.AddText("New Tab", acc("t"), emit("new-tab"))
	s.AddText("New Session…", acc2("t"), emit("new-session"))
	s.AddText("New Local Terminal", acc("l"), emit("new-local"))
	s.AddText("New Window", acc2("n"), func(*menu.CallbackData) {
		if err := app.NewWindow(); err != nil {
			wruntime.LogErrorf(app.ctx, "new window: %v", err)
		}
	})
	s.AddText("Close Pane", acc("w"), emit("close-tab"))
	s.AddSeparator()
	s.AddText("Split Right", acc("d"), emit("split-right"))
	s.AddText("Split Down", acc2("d"), emit("split-down"))
	s.AddText("Zoom Pane", acc2("enter"), emit("zoom"))
	focus := s.AddSubmenu("Focus Pane")
	for _, d := range []string{"left", "right", "up", "down"} {
		focus.AddText(strings.ToUpper(d[:1])+d[1:], keys.Combo(d, keys.CmdOrCtrlKey, keys.OptionOrAltKey), emit("focus", d))
	}
	s.AddSeparator()
	// Most-recently-used switching, like the app switcher: hold the modifier, Tab to move.
	sw := s.AddSubmenu("Switch Session")
	sw.AddText("Most Recent", keys.Control("tab"), emit("switch", 1, "Control"))
	sw.AddText("Least Recent", keys.Combo("tab", keys.ControlKey, keys.ShiftKey), emit("switch", -1, "Control"))
	sw.AddText("Most Recent (Option)", keys.OptionOrAlt("tab"), emit("switch", 1, "Alt"))
	sw.AddText("Least Recent (Option)", keys.Combo("tab", keys.OptionOrAltKey, keys.ShiftKey), emit("switch", -1, "Alt"))
	s.AddText("Next Session That Needs You", acc("j"), emit("needs-you"))
	s.AddText("Join a Shared Session…", acc2("j"), emit("join"))
	s.AddSeparator()
	s.AddText("Command Palette…", acc("k"), emit("palette"))
	s.AddText("Write a Prompt…", acc("e"), emit("composer"))
	s.AddText("Recipes…", acc2("r"), emit("recipes"))
	s.AddText("New Machine…", acc("n"), emit("new-machine"))
	s.AddText("Files on Its Machine…", acc("o"), emit("files"))
	s.AddText("Its Machine's Screen", acc2("s"), emit("screen"))
	s.AddText("Conversation History…", acc("y"), emit("history"))
	s.AddText("Search Everything…", acc2("f"), emit("search-all"))
	s.AddSeparator()
	s.AddText("Next Tab", keys.Combo("]", keys.CmdOrCtrlKey, keys.ShiftKey), emit("next-tab"))
	s.AddText("Previous Tab", keys.Combo("[", keys.CmdOrCtrlKey, keys.ShiftKey), emit("prev-tab"))
	tabs := s.AddSubmenu("Go to Tab")
	for i := 1; i <= 9; i++ {
		tabs.AddText("Tab "+string(rune('0'+i)), acc(string(rune('0'+i))), emit("tab", i))
	}
	v := m.AddSubmenu("View")
	v.AddText("Toggle Sidebar", acc("b"), emit("sidebar"))
	v.AddText("Zoom In", acc("="), emit("zoom-in"))
	v.AddText("Zoom Out", acc("-"), emit("zoom-out"))
	v.AddText("Actual Size", acc("0"), emit("zoom-reset"))
	v.AddSeparator()
	for i, name := range []string{"Home", "Sessions", "Machines", "Sync", "Projects", "Accounts", "Settings"} {
		v.AddText(name, keys.Combo(string(rune('1'+i)), keys.CmdOrCtrlKey, keys.OptionOrAltKey), emit("view", name))
	}
	v.AddSeparator()
	v.AddText("Reload Data", acc("r"), emit("reload"))
	if mac {
		// Each window is its own app instance, so the system's ⌘` doesn't cycle them.
		v.AddSeparator()
		v.AddText("Next Window", keys.CmdOrCtrl("`"), func(*menu.CallbackData) { _ = app.NextWindow() })
		m.Append(menu.WindowMenu())
	}
	h := m.AddSubmenu("Help")
	h.AddText("Welcome to Lungo", nil, emit("welcome"))
	return m
}
