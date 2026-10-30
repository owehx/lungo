#!/bin/sh
# Builds the tmux that ships inside Lungo.app (Contents/Helpers/tmux), for Macs that have none:
# sessions on this computer are tmux sessions, and macOS doesn't come with it. One universal
# binary (Apple silicon and Intel) that needs nothing but macOS: libevent, utf8proc and
# jemalloc are built in (tmux 3.7c wants jemalloc on macOS, for a bug in its calloc), and
# ncurses is the system's, so it reads the system's terminal descriptions.
# The same version the app is tested with on Homebrew. Prints the binary's path; a build
# already made is reused.
#
#   scripts/build-tmux.sh
set -eu

# A new version reaches running servers only when they restart (they keep the program that
# started them), and clients talk to an older server while tmux's protocol version is the same.
TMUX_V=3.7c
TMUX_SHA=7c60cae9a0e25288e2e24750aafc9e8800fc7fd4555e447e1b29ee4201cfb3bf
EVENT_V=2.1.13
EVENT_SHA=f7e9383b8c0baa81b687e5b5eecc01beefaf1b19b64151d95ed61647fe7a315c
UTF8PROC_V=2.12.0
UTF8PROC_SHA=f564011d38b2888d583d510b08e69ffa15aa117155db1b9b49ef1dfe1fa25111
JEMALLOC_V=5.4.0
JEMALLOC_SHA=200776fac271093e7c2f21edd6d62657ecd2be578d9328633f2a86bfa6ef4f1d
MIN_MACOS=13.0 # the app's LSMinimumSystemVersion

cd "$(dirname "$0")/.."
OUT=$PWD/dist/tmux-$TMUX_V
if [ -x "$OUT/tmux" ]; then
	echo "$OUT/tmux"
	exit 0
fi
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

fetch() { # url sha256 → the file, checked
	f=$WORK/src/$(basename "$1")
	mkdir -p "$WORK/src"
	curl -fsSL --retry 3 -o "$f" "$1"
	echo "$2  $f" | shasum -a 256 -c - >/dev/null || { echo "checksum mismatch: $1" >&2; exit 1; }
	echo "$f"
}
EVENT_TGZ=$(fetch "https://github.com/libevent/libevent/releases/download/release-$EVENT_V-stable/libevent-$EVENT_V-stable.tar.gz" $EVENT_SHA)
UTF8PROC_TGZ=$(fetch "https://github.com/JuliaStrings/utf8proc/archive/refs/tags/v$UTF8PROC_V.tar.gz" $UTF8PROC_SHA)
JEMALLOC_TBZ=$(fetch "https://github.com/jemalloc/jemalloc/releases/download/$JEMALLOC_V/jemalloc-$JEMALLOC_V.tar.bz2" $JEMALLOC_SHA)
TMUX_TGZ=$(fetch "https://github.com/tmux/tmux/releases/download/$TMUX_V/tmux-$TMUX_V.tar.gz" $TMUX_SHA)

for arch in arm64 x86_64; do
	B=$WORK/$arch
	P=$B/prefix
	mkdir -p "$B" "$P/include" "$P/lib"
	host=; [ "$arch" = x86_64 ] && [ "$(uname -m)" != x86_64 ] && host=--host=x86_64-apple-darwin
	[ "$arch" = arm64 ] && lgpage=14 || lgpage=12 # 16K pages on Apple silicon, 4K on Intel
	cflags="-arch $arch -mmacosx-version-min=$MIN_MACOS -O2"
	# Nothing from Homebrew or the shell's own flags gets in.
	set -- CC=clang "CFLAGS=$cflags" CPPFLAGS= "LDFLAGS=-arch $arch -mmacosx-version-min=$MIN_MACOS"
	export PKG_CONFIG_LIBDIR=$P/lib/pkgconfig PKG_CONFIG_PATH=

	tar -xzf "$EVENT_TGZ" -C "$B"
	(cd "$B/libevent-$EVENT_V-stable" && ./configure -q $host --prefix="$P" --disable-shared --enable-static \
		--disable-openssl --disable-mbedtls --disable-samples --disable-libevent-regress --disable-debug-mode \
		--disable-dependency-tracking "$@" && make -s -j8 && make -s install) >"$B/libevent.log" 2>&1 ||
		{ tail -30 "$B/libevent.log" >&2; exit 1; }

	tar -xzf "$UTF8PROC_TGZ" -C "$B"
	(cd "$B/utf8proc-$UTF8PROC_V" && make -s libutf8proc.a CC=clang "CFLAGS=$cflags" &&
		cp utf8proc.h "$P/include/" && cp libutf8proc.a "$P/lib/") >"$B/utf8proc.log" 2>&1 ||
		{ tail -30 "$B/utf8proc.log" >&2; exit 1; }

	# No je_ prefix, as Homebrew builds it: jemalloc then also takes over macOS's own malloc
	# (a malloc zone it registers as the program starts). force_load keeps the object that
	# registers it, which nothing references by name.
	tar -xjf "$JEMALLOC_TBZ" -C "$B"
	(cd "$B/jemalloc-$JEMALLOC_V" && ./configure -q $host --prefix="$P" --with-jemalloc-prefix= --with-lg-page=$lgpage \
		--disable-cxx --disable-debug "$@" && make -s -j8 build_lib_static && make -s install_include install_lib_static) >"$B/jemalloc.log" 2>&1 ||
		{ tail -30 "$B/jemalloc.log" >&2; exit 1; }

	tar -xzf "$TMUX_TGZ" -C "$B"
	(cd "$B/tmux-$TMUX_V" && ./configure -q $host --enable-utf8proc --enable-jemalloc --disable-dependency-tracking "$@" \
		"LIBEVENT_CORE_CFLAGS=-I$P/include" "LIBEVENT_CORE_LIBS=$P/lib/libevent_core.a" \
		"LIBUTF8PROC_CFLAGS=-I$P/include" "LIBUTF8PROC_LIBS=$P/lib/libutf8proc.a" \
		"JEMALLOC_CFLAGS=-I$P/include" "JEMALLOC_LIBS=-Wl,-force_load,$P/lib/libjemalloc.a" && make -s -j8) >"$B/tmux.log" 2>&1 ||
		{ tail -30 "$B/tmux.log" >&2; exit 1; }
done

mkdir -p "$OUT"
lipo -create "$WORK/arm64/tmux-$TMUX_V/tmux" "$WORK/x86_64/tmux-$TMUX_V/tmux" -output "$WORK/tmux"
strip -x "$WORK/tmux"
# Only macOS's own libraries, or it won't start on a Mac without Homebrew.
if otool -L "$WORK/tmux" | grep '^	' | grep -v -e '^	/usr/lib/' -e '^	/System/' >&2; then
	echo "tmux links a library macOS doesn't have (above)" >&2
	exit 1
fi
mv "$WORK/tmux" "$OUT/tmux"
echo "$OUT/tmux"
