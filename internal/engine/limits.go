package engine

import (
	"bufio"
	"bytes"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"skybuild/internal/paths"
)

// Sessions stopped at a usage limit.
//
// When Claude hits a usage limit it writes the error into the conversation ("You've hit your
// 5-hour limit · resets 12pm (America/New_York)", an assistant entry marked as an API error)
// and either goes back to its prompt or waits for the reset by itself ("continuing
// automatically at 12pm · esc to cancel"). Neither looks like a limit on screen, where older
// Claude Codes showed a menu. So the conversation itself is read: a session is stopped at a
// limit when the newest thing Claude said in it is that error. The rotation (ClaudeTick) then
// moves its account off at once, and the session is restarted on the next one and told to go
// on (see restartClaude).

// limitFacts is what the end of a conversation says about a limit: the limit error, when it
// came, and when you last typed something after it (zero: nothing since).
type limitFacts struct {
	Text        string
	At          time.Time
	PromptAfter time.Time
}

// stopped says whether the conversation is stopped at the limit. A prompt typed after the
// error while Claude works is a new try, still under way.
func (f limitFacts) stopped(busy bool) bool {
	if f.Text == "" || !IsLimitMessage(f.Text) {
		return false
	}
	return !(busy && f.PromptAfter.After(f.At))
}

// transcriptTail is how much of the end of a conversation is read: the limit error is short
// and the newest entry Claude wrote, but entries after it (agents reporting back, a long tool
// result) can be large.
const transcriptTail = 400 << 10

// scanLimit reads the end of a conversation (a .jsonl transcript): the newest entry Claude
// wrote, if it is a usage-limit error, and the newest prompt typed after it.
func scanLimit(r io.Reader) limitFacts {
	var f limitFacts
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 64<<10), transcriptTail+1)
	first := true
	for sc.Scan() {
		line := sc.Bytes()
		if first { // the read may start in the middle of an entry
			first = false
			if !bytes.HasPrefix(line, []byte("{")) {
				continue
			}
		}
		switch {
		case bytes.Contains(line, []byte(`"type":"assistant"`)):
			f = limitFacts{}
			var e struct {
				IsAPIError bool      `json:"isApiErrorMessage"`
				Error      string    `json:"error"`
				Timestamp  time.Time `json:"timestamp"`
				Message    struct {
					Content []struct {
						Text string `json:"text"`
					} `json:"content"`
				} `json:"message"`
			}
			if !bytes.Contains(line, []byte(`"isApiErrorMessage":true`)) || json.Unmarshal(line, &e) != nil || e.Error != "rate_limit" {
				continue
			}
			for _, c := range e.Message.Content {
				if c.Text != "" {
					f.Text = strings.TrimSpace(c.Text)
					break
				}
			}
			f.At = e.Timestamp
		case f.Text != "" && bytes.Contains(line, []byte(`"type":"user"`)) && typedPrompt(line):
			var e struct {
				Timestamp time.Time `json:"timestamp"`
			}
			if json.Unmarshal(line, &e) == nil {
				f.PromptAfter = e.Timestamp
			}
		}
	}
	return f
}

// typedPrompt: a user entry that is something you sent, not a tool's result or an agent
// reporting back.
func typedPrompt(line []byte) bool {
	return !bytes.Contains(line, []byte(`"tool_use_id"`)) && !bytes.Contains(line, []byte(`<task-notification>`)) && !bytes.Contains(line, []byte(`"isMeta":true`))
}

// limitAwk is scanLimit for a machine, run on the end of a conversation there: it prints
// "<error time>\t<prompt typed after>\t<error text>", or an empty line.
const limitAwk = `function ts(l) { if (match(l, /"timestamp":"[^"]*"/)) return substr(l, RSTART + 13, RLENGTH - 14); return "" }
NR == 1 && substr($0, 1, 1) != "{" { next }
/"type":"assistant"/ {
  t = ""; x = ""; u = ""
  if ($0 ~ /"isApiErrorMessage":true/ && $0 ~ /"error":"rate_limit"/) {
    t = ts($0)
    if (match($0, /"text":"[^"]*"/)) x = substr($0, RSTART + 8, RLENGTH - 9)
  }
  next
}
t != "" && /"type":"user"/ && $0 !~ /"tool_use_id"|<task-notification>|"isMeta":true/ { u = ts($0) }
END { if (t != "") printf "%s\t%s\t%s\n", t, u, x; else print "" }`

// limitScript prints a "@@sky-limit@@<session>\t<limitAwk's line>" for each Claude pane in $H
// (the panes agentPanesAwk listed) whose conversation is known.
const limitScript = `printf '%s\n' "$H" | awk -F'\t' '/^@@sky-pane@@/ && NF >= 3 { split($3, r, " "); if (r[1] ~ /^[A-Za-z0-9_-]+$/) print substr($1, 13), r[1] }' | while read -r s sid; do f=$(ls "$HOME"/.claude/projects/*/"$sid".jsonl 2>/dev/null | head -1); [ -n "$f" ] && printf '@@sky-limit@@%s\t%s\n' "$s" "$(tail -c ` + "409600" + ` "$f" | awk '` + limitAwk + `')"; done`

// parseLimits reads limitScript's lines: session → what its conversation says.
func parseLimits(raw string) map[string]limitFacts {
	out := map[string]limitFacts{}
	for _, chunk := range strings.Split(raw, "@@sky-limit@@")[1:] {
		line, _, _ := strings.Cut(chunk, "\n")
		f := strings.SplitN(strings.TrimRight(line, "\r"), "\t", 4)
		if len(f) < 4 || f[1] == "" {
			continue
		}
		var lf limitFacts
		lf.At, _ = time.Parse(time.RFC3339Nano, f[1])
		lf.PromptAfter, _ = time.Parse(time.RFC3339Nano, f[2])
		lf.Text = strings.TrimSpace(jsonText(f[3]))
		out[strings.TrimSpace(f[0])] = lf
	}
	return out
}

// applyLimit marks a Claude session stopped at a usage limit, from what its conversation says.
func applyLimit(s *Session, f limitFacts, busy bool) {
	if !s.Claude || !f.stopped(busy) {
		return
	}
	s.Limit, s.LimitAt = f.Text, f.At
	s.State, s.Message = "waiting", f.Text
}

// limitFresh is how long after a limit the session counts as just stopped by it, which says
// the account it is on is used up (later, it is an old limit left on a session nobody went
// on with).
const limitFresh = 15 * time.Minute

// FreshLimit reports whether the session was just stopped at a limit by the Claude that runs
// in it now (not one from before it was restarted).
func (s Session) FreshLimit(now time.Time) bool {
	if s.Limit == "" || s.LimitAt.IsZero() || now.Sub(s.LimitAt) > limitFresh {
		return false
	}
	return s.ClaudeSince.IsZero() || s.LimitAt.After(s.ClaudeSince.Add(-2*time.Second))
}

// localTranscripts remembers where each conversation's transcript is, and what its end said
// at a size and time, so a session costs a stat when nothing changed.
var localTranscripts = struct {
	sync.Mutex
	path  map[string]string
	seen  map[string]string // path → "size mtime" when last read
	facts map[string]limitFacts
}{path: map[string]string{}, seen: map[string]string{}, facts: map[string]limitFacts{}}

// localLimit is what the end of a conversation on this computer says about a limit.
func localLimit(sid string) limitFacts {
	if !sessionID.MatchString(sid) {
		return limitFacts{}
	}
	t := &localTranscripts
	t.Lock()
	defer t.Unlock()
	p := t.path[sid]
	st, err := os.Stat(p)
	if p == "" || err != nil {
		dir := os.Getenv("CLAUDE_CONFIG_DIR")
		if dir == "" {
			dir = filepath.Join(paths.Home(), ".claude")
		}
		m, _ := filepath.Glob(filepath.Join(dir, "projects", "*", sid+".jsonl"))
		if len(m) == 0 {
			return limitFacts{}
		}
		p = m[0]
		if st, err = os.Stat(p); err != nil {
			return limitFacts{}
		}
		t.path[sid] = p
	}
	key := strconv.FormatInt(st.Size(), 10) + " " + strconv.FormatInt(st.ModTime().UnixNano(), 10)
	if t.seen[p] == key {
		return t.facts[p]
	}
	file, err := os.Open(p)
	if err != nil {
		return limitFacts{}
	}
	defer file.Close()
	if st.Size() > transcriptTail {
		file.Seek(st.Size()-transcriptTail, io.SeekStart)
	}
	f := scanLimit(file)
	t.seen[p], t.facts[p] = key, f
	return f
}

var (
	reResetAt    = regexp.MustCompile(`(?i)resets\s+(?:(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+(\d{1,2})\s+at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)(?:\s*\(([^)]+)\))?`)
	limitWindows = map[string]string{"5-hour": "five_hour", "weekly": "seven_day"}
	months       = map[string]time.Month{"jan": 1, "feb": 2, "mar": 3, "apr": 4, "may": 5, "jun": 6, "jul": 7, "aug": 8, "sep": 9, "oct": 10, "nov": 11, "dec": 12}
)

// ParseReset reads when a limit message says the limit ends ("resets 12pm (America/New_York)",
// "resets Nov 23 at 8am (…)"), from when it was given; zero when it doesn't say.
func ParseReset(text string, at time.Time) time.Time {
	m := reResetAt.FindStringSubmatch(text)
	if m == nil {
		return time.Time{}
	}
	loc := time.Local
	if m[6] != "" {
		if l, err := time.LoadLocation(strings.TrimSpace(m[6])); err == nil {
			loc = l
		}
	}
	h, _ := strconv.Atoi(m[3])
	mins, _ := strconv.Atoi(m[4])
	if h == 12 {
		h = 0
	}
	if strings.EqualFold(m[5], "pm") {
		h += 12
	}
	base := at.In(loc)
	if m[1] != "" {
		day, _ := strconv.Atoi(m[2])
		t := time.Date(base.Year(), months[strings.ToLower(m[1][:3])], day, h, mins, 0, 0, loc)
		if t.Before(base.Add(-24 * time.Hour)) { // "Jan 2" said in December
			t = t.AddDate(1, 0, 0)
		}
		return t
	}
	t := time.Date(base.Year(), base.Month(), base.Day(), h, mins, 0, 0, loc)
	if !t.After(base) {
		t = t.AddDate(0, 0, 1)
	}
	return t
}

// limitWindow is the usage window a limit message names ("five_hour", "seven_day"), or "".
func limitWindow(text string) string {
	low := strings.ToLower(text)
	for word, w := range limitWindows {
		if strings.Contains(low, word+" limit") {
			return w
		}
	}
	return ""
}

// Messages a session gets after it was stopped at a limit, as its next prompt.
const (
	continueMoved = "Continue where you left off. (A usage limit stopped you; Lungo moved this session to another Claude account. Rerun any agents or commands that stopped at the limit.)"
	continueReset = "Continue where you left off. (A usage limit stopped you and it has reset. Rerun any agents or commands that stopped at the limit.)"
)
