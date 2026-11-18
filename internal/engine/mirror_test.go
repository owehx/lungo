package engine

import (
	"testing"
)

func TestNoteMove(t *testing.T) {
	t.Setenv("SKYBUILD_HOME", t.TempDir())
	plan := func(from, fromDir, to, toDir string) MoveResult {
		return MoveResult{MovePlan: MovePlan{From: from, FromDir: fromDir, To: to, ToDir: toDir}}
	}
	// Off this Mac to a machine: followed here.
	if err := NoteMove(plan(LocalMachine, "/Users/t/p", "demo", "/home/t/p")); err != nil {
		t.Fatal(err)
	}
	if m := Mirrors(); len(m) != 1 || m[0].Machine != "demo" || m[0].Remote != "/home/t/p" || m[0].Local != "/Users/t/p" {
		t.Fatalf("after leaving: %+v", m)
	}
	if m, err := MirrorOf("demo", "/home/t/p/sub"); err != nil || m.Local != "/Users/t/p" {
		t.Fatalf("mirror of a folder inside: %+v %v", m, err)
	}
	if _, err := MirrorOf("demo", "/home/t/pp"); err != ErrNotMirrored {
		t.Fatalf("a folder that only starts the same: %v", err)
	}
	// On to another machine: the mirror goes along, to the same folder here.
	NoteMove(plan("demo", "/home/t/p", "mini", "/Users/x/p"))
	if m := Mirrors(); len(m) != 1 || m[0].Machine != "mini" || m[0].Remote != "/Users/x/p" || m[0].Local != "/Users/t/p" {
		t.Fatalf("after moving on: %+v", m)
	}
	// Between machines it never was here: nothing to follow.
	NoteMove(plan("demo", "/home/t/q", "mini", "/Users/x/q"))
	if m := Mirrors(); len(m) != 1 {
		t.Fatalf("a move between machines started a mirror: %+v", m)
	}
	// Home again: no mirror.
	NoteMove(plan("mini", "/Users/x/p", LocalMachine, "/Users/t/p"))
	if m := Mirrors(); len(m) != 0 {
		t.Fatalf("after coming home: %+v", m)
	}
}
