package engine

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"skybuild/internal/paths"
)

// Scrolling in Claude Code.
//
// In its full-screen view Claude Code scrolls by itself on wheel input, and ramps the speed
// up when wheel steps come fast: up to six rows a step, fifteen after a change of direction.
// That suits a terminal that sends one step per notch. Sky's terminal sends one step per
// line the fingers travel (as iTerm and Ghostty do), so the ramp makes a trackpad overshoot
// and jump. Claude Code has a setting for it; with the ramp off a step is a row, and the
// view follows the fingers. It is read when Claude starts.

const wheelAccelKey = "wheelScrollAccelerationEnabled"

var wheelAccelValue = regexp.MustCompile(`("` + wheelAccelKey + `"\s*:\s*)(true|false)`)
var wheelAccelEntry = regexp.MustCompile(`\s*"` + wheelAccelKey + `"\s*:\s*(true|false)\s*,?`)

func claudeSettingsPath() string {
	dir := os.Getenv("CLAUDE_CONFIG_DIR")
	if dir == "" {
		dir = filepath.Join(paths.Home(), ".claude")
	}
	return filepath.Join(dir, "settings.json")
}

// ClaudePreciseScroll reports whether the ramp is turned off in this computer's Claude
// settings (which sync also carries to the machines).
func ClaudePreciseScroll() bool {
	b, err := os.ReadFile(claudeSettingsPath())
	if err != nil {
		return false
	}
	var m map[string]any
	if json.Unmarshal(b, &m) != nil {
		return false
	}
	v, ok := m[wheelAccelKey].(bool)
	return ok && !v
}

// SetClaudePreciseScroll turns the ramp off (on = precise) or gives the choice back to
// Claude Code. The rest of the settings file is left exactly as it is written.
func SetClaudePreciseScroll(on bool) error {
	path := claudeSettingsPath()
	b, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		if !on {
			return nil
		}
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			return err
		}
		return os.WriteFile(path, []byte("{\n  \""+wheelAccelKey+"\": false\n}\n"), 0o600)
	}
	if err != nil {
		return err
	}
	var m map[string]any
	if err := json.Unmarshal(b, &m); err != nil {
		return errors.New("~/.claude/settings.json is not valid JSON; fix it and try again")
	}
	text := string(b)
	_, has := m[wheelAccelKey]
	switch {
	case on && has:
		text = wheelAccelValue.ReplaceAllString(text, "${1}false")
	case on && len(m) == 0:
		text = "{\n  \"" + wheelAccelKey + "\": false\n}\n"
	case on:
		i := strings.Index(text, "{")
		text = text[:i+1] + "\n  \"" + wheelAccelKey + "\": false," + text[i+1:]
	case has:
		text = wheelAccelEntry.ReplaceAllString(text, "")
	default:
		return nil
	}
	// The edit is textual so the file keeps its shape; if that went wrong, write it plainly.
	var check map[string]any
	if json.Unmarshal([]byte(text), &check) != nil || (on && check[wheelAccelKey] != false) || (!on && check[wheelAccelKey] != nil) {
		if on {
			m[wheelAccelKey] = false
		} else {
			delete(m, wheelAccelKey)
		}
		out, err := json.MarshalIndent(m, "", "  ")
		if err != nil {
			return err
		}
		text = string(out) + "\n"
	}
	mode := os.FileMode(0o600)
	if st, err := os.Stat(path); err == nil {
		mode = st.Mode().Perm()
	}
	tmp := path + ".sky-tmp"
	if err := os.WriteFile(tmp, []byte(text), mode); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// RestartClaude restarts Claude Code in a session and resumes its conversation: what it takes
// for a running session to pick up a changed setting or an update. sid is the conversation
// (without one, the latest in the folder); flags are how Claude was started before.
func (e *Engine) RestartClaude(ctx context.Context, machine, session, sid, flags string) error {
	ctx, cancel := context.WithTimeout(ctx, 40*time.Second)
	defer cancel()
	return e.restartClaude(ctx, machine, session, sid, flags, "", "")
}
