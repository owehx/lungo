// Package collab shares a session with other people, the way a document is shared: everyone
// in it sees the same terminal and can type into it, sees where the others point and what
// they select, and opens the ports its programs listen on from their own computer.
//
// Nothing is hosted anywhere. The computer that has the session serves it (Hub) to the
// tailnet only, and Tailscale carries the connections and says who is on the other end of
// each. An invite is a short code (lungo://join/7KX-4PQ is the same code as a link): the
// guest's app asks the computers on its tailnet which of them shares that code, and the one
// that does says the share and its key. Anyone on the tailnet (or anyone the computer is
// shared with in Tailscale) who has the code can join (Guest).
package collab

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"hash/fnv"
	"math/big"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/gofrs/flock"
)

// DefaultPort is where a computer serves its shared sessions on the tailnet.
const DefaultPort = 47863

// Roles a person can have in a share.
const (
	Edit = "edit" // sees it and types into it
	View = "view" // sees it
)

// Share is a session someone shared. It has two keys: a link with the first lets people
// type along, one with the second lets them watch; the person sharing can change that for
// anyone once they are in. Each key has a code, which is what people are sent.
type Share struct {
	ID       string    `json:"id"`
	Machine  string    `json:"machine"` // the session's machine (engine.LocalMachine: this computer)
	Session  string    `json:"session"`
	Title    string    `json:"title"`
	EditKey  string    `json:"editKey"`
	ViewKey  string    `json:"viewKey"`
	EditCode string    `json:"editCode,omitempty"`
	ViewCode string    `json:"viewCode,omitempty"`
	Created  time.Time `json:"created"`
	// People (see Person.Who) whose role was changed after they joined, and who were removed.
	ViewOnly []string `json:"viewOnly,omitempty"`
	CanType  []string `json:"canType,omitempty"`
	Removed  []string `json:"removed,omitempty"`
}

// role is what a key lets its holder do; "" for no key of this share.
func (s *Share) role(key string) string {
	switch {
	case key == "":
		return ""
	case subtle.ConstantTimeCompare([]byte(key), []byte(s.EditKey)) == 1:
		return Edit
	case subtle.ConstantTimeCompare([]byte(key), []byte(s.ViewKey)) == 1:
		return View
	}
	return ""
}

// codeRole is what a code lets its holder do, with the key that does it ("" for no code of
// this share).
func (s *Share) codeRole(code string) (role, key string) {
	switch {
	case code == "":
	case s.EditCode != "" && subtle.ConstantTimeCompare([]byte(code), []byte(s.EditCode)) == 1:
		return Edit, s.EditKey
	case s.ViewCode != "" && subtle.ConstantTimeCompare([]byte(code), []byte(s.ViewCode)) == 1:
		return View, s.ViewKey
	}
	return "", ""
}

// roleOf is a person's role: what the key they came with allows, unless it was changed.
func (s *Share) roleOf(who, keyRole string) string {
	switch {
	case slices.Contains(s.Removed, who):
		return ""
	case slices.Contains(s.ViewOnly, who):
		return View
	case slices.Contains(s.CanType, who):
		return Edit
	}
	return keyRole
}

// SetRole lets someone type (Edit) or only watch (View).
func (s *Share) SetRole(who, role string) {
	s.ViewOnly = slices.DeleteFunc(s.ViewOnly, func(x string) bool { return x == who })
	s.CanType = slices.DeleteFunc(s.CanType, func(x string) bool { return x == who })
	if role == View {
		s.ViewOnly = append(s.ViewOnly, who)
	} else {
		s.CanType = append(s.CanType, who)
	}
}

// Remove takes someone out; their link no longer lets them in.
func (s *Share) Remove(who string) {
	if !slices.Contains(s.Removed, who) {
		s.Removed = append(s.Removed, who)
	}
}

func randKey(n int) string {
	b := make([]byte, n)
	rand.Read(b)
	return base64.RawURLEncoding.EncodeToString(b)
}

// NewShare makes a share of a session with fresh keys, and codes for them that start with
// the letter of host (this computer's tailnet address; see CodeHint).
func NewShare(machine, session, title, host string) Share {
	s := Share{ID: randKey(6), Machine: machine, Session: session, Title: title, EditKey: randKey(18), ViewKey: randKey(18), Created: time.Now()}
	s.Recode(host, nil)
	return s
}

// Recode gives the share codes when it has none (it was made before there were codes),
// different from the codes of the others.
func (s *Share) Recode(host string, others []Share) {
	taken := map[string]bool{}
	for _, o := range others {
		taken[o.EditCode], taken[o.ViewCode] = true, true
	}
	for s.EditCode == "" || taken[s.EditCode] {
		s.EditCode = newCode(host)
	}
	taken[s.EditCode] = true
	for s.ViewCode == "" || taken[s.ViewCode] {
		s.ViewCode = newCode(host)
	}
}

// ---------- codes ----------

// A code is six characters people can read out and type: no 0/O, 1/I/L. It is shown as
// 7KX-4PQ; typed in any case, with or without the dash or spaces.
const codeChars = "23456789ABCDEFGHJKMNPQRSTUVWXYZ"

const codeLen = 6

// CodeHint is the first character of the codes a computer hands out, from its tailnet
// address: someone joining asks the computers whose letter it is first, so a code is found
// at once on a tailnet of hundreds of devices too.
func CodeHint(host string) byte {
	h := fnv.New32a()
	h.Write([]byte(host))
	return codeChars[h.Sum32()%uint32(len(codeChars))]
}

// newCode is a fresh code: the hint, then five random characters, with at least one digit
// and one letter (so a word typed in the command palette is never taken for one).
func newCode(host string) string {
	n := big.NewInt(int64(len(codeChars)))
	for {
		b := []byte{CodeHint(host)}
		for len(b) < codeLen {
			i, err := rand.Int(rand.Reader, n)
			if err != nil {
				panic(err)
			}
			b = append(b, codeChars[i.Int64()])
		}
		c := string(b)
		if strings.ContainsAny(c, "23456789") && strings.ContainsAny(c, "ABCDEFGHJKMNPQRSTUVWXYZ") {
			return c
		}
	}
}

// NormalCode reads a code as typed ("7kx-4pq", "7KX 4PQ"): the code, or "" when it isn't one.
func NormalCode(s string) string {
	var b strings.Builder
	for _, r := range strings.ToUpper(s) {
		switch {
		case r == '-' || r == ' ' || r == '\t':
		case strings.ContainsRune(codeChars, r):
			b.WriteRune(r)
		default:
			return ""
		}
	}
	if b.Len() != codeLen {
		return ""
	}
	return b.String()
}

// ShowCode is how a code is shown: 7KX-4PQ.
func ShowCode(c string) string {
	if len(c) != codeLen {
		return c
	}
	return c[:3] + "-" + c[3:]
}

// ---------- the shares this computer has ----------

// Store keeps the shares in a file every window of the app reads: whichever window runs the
// hub serves them, and any window can change them.
type Store struct{ dir string }

func NewStore(dir string) *Store { return &Store{dir: dir} }

func (s *Store) path() string { return filepath.Join(s.dir, "shares.json") }

// Load returns the shares (none when there is no file yet).
func (s *Store) Load() ([]Share, error) {
	b, err := os.ReadFile(s.path())
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var f struct {
		Shares []Share `json:"shares"`
	}
	if err := json.Unmarshal(b, &f); err != nil {
		return nil, err
	}
	return f.Shares, nil
}

// Update changes the shares under a lock, so two windows can't write over each other.
func (s *Store) Update(fn func([]Share) ([]Share, error)) error {
	if err := os.MkdirAll(s.dir, 0o700); err != nil {
		return err
	}
	l := flock.New(filepath.Join(s.dir, "shares.lock"))
	if err := l.Lock(); err != nil {
		return err
	}
	defer l.Unlock()
	cur, err := s.Load()
	if err != nil {
		return err
	}
	next, err := fn(cur)
	if err != nil {
		return err
	}
	b, err := json.MarshalIndent(struct {
		Shares []Share `json:"shares"`
	}{nonNil(next)}, "", "  ")
	if err != nil {
		return err
	}
	tmp := s.path() + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, s.path())
}

func nonNil(s []Share) []Share {
	if s == nil {
		return []Share{}
	}
	return s
}

// modified is when the shares last changed (zero without a file).
func (s *Store) modified() time.Time {
	st, err := os.Stat(s.path())
	if err != nil {
		return time.Time{}
	}
	return st.ModTime()
}

// LocalKey lets this computer's own windows into the hub: the person sharing, in the panes
// that show the session. It lives in a file only this user can read.
func (s *Store) LocalKey() (string, error) {
	path := filepath.Join(s.dir, "local.key")
	if b, err := os.ReadFile(path); err == nil && len(strings.TrimSpace(string(b))) >= 16 {
		return strings.TrimSpace(string(b)), nil
	}
	if err := os.MkdirAll(s.dir, 0o700); err != nil {
		return "", err
	}
	key := randKey(24)
	// Two windows asking at once: the file made first wins.
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		if b, rerr := os.ReadFile(path); rerr == nil {
			return strings.TrimSpace(string(b)), nil
		}
		return "", err
	}
	defer f.Close()
	_, err = f.WriteString(key)
	return key, err
}

// ---------- invite links ----------

// Invite is what a link carries: where the session is served, which share, the key, and
// enough to show before connecting. The link people are sent carries only a code (Code):
// the rest is found by asking the computers on the tailnet for it (Guest.Find).
type Invite struct {
	Host  string // the sharing computer's tailnet address
	Port  int
	Share string
	Key   string
	By    string // who shares it
	Title string
	Code  string
}

const scheme = "lungo"

// CodeLink is the link for a code: lungo://join/7KX-4PQ.
func CodeLink(code string) string { return scheme + "://join/" + ShowCode(code) }

// Link is the invite as a link to send: lungo://join/100.x.y.z:47863/<share>?k=<key>&by=…&t=…
func (i Invite) Link() string {
	q := url.Values{}
	q.Set("k", i.Key)
	if i.By != "" {
		q.Set("by", i.By)
	}
	if i.Title != "" {
		q.Set("t", i.Title)
	}
	u := url.URL{Scheme: scheme, Host: "join", Path: "/" + net.JoinHostPort(i.Host, strconv.Itoa(i.Port)) + "/" + i.Share, RawQuery: q.Encode()}
	return u.String()
}

var (
	shareID = regexp.MustCompile(`^[A-Za-z0-9_-]{4,40}$`)
	codeIn  = regexp.MustCompile(`(?i)\b[2-9a-hjkmnp-z]{3}-[2-9a-hjkmnp-z]{3}\b`)
)

// ParseLink reads an invite: a link, or a code on its own. Pasted text around a link (a chat
// message) is fine.
func ParseLink(s string) (Invite, error) {
	s = strings.TrimSpace(s)
	if c := NormalCode(s); c != "" {
		return Invite{Code: c}, nil
	}
	if i := strings.Index(s, scheme+"://"); i >= 0 {
		s = s[i:]
		if end := strings.IndexAny(s, " \t\r\n<>\"'"); end >= 0 {
			s = s[:end]
		}
	} else if m := codeIn.FindString(s); m != "" {
		return Invite{Code: NormalCode(m)}, nil // "join me: 7KX-4PQ"
	}
	u, err := url.Parse(s)
	if err != nil || u.Scheme != scheme || u.Host != "join" {
		return Invite{}, errors.New("that isn't a Lungo code or invite link: a code looks like 7KX-4PQ, a link starts with lungo://join/")
	}
	parts := strings.Split(strings.Trim(u.Path, "/"), "/")
	if len(parts) == 1 {
		if c := NormalCode(parts[0]); c != "" {
			return Invite{Code: c}, nil
		}
	}
	if len(parts) != 2 {
		return Invite{}, errors.New("this invite link is cut short")
	}
	host, port, err := net.SplitHostPort(parts[0])
	n, perr := strconv.Atoi(port)
	if err != nil || perr != nil || n <= 0 || n > 65535 || host == "" {
		return Invite{}, fmt.Errorf("this invite link has no address in it")
	}
	q := u.Query()
	inv := Invite{Host: host, Port: n, Share: parts[1], Key: q.Get("k"), By: q.Get("by"), Title: q.Get("t")}
	if !shareID.MatchString(inv.Share) || inv.Key == "" {
		return Invite{}, errors.New("this invite link is cut short")
	}
	return inv, nil
}
