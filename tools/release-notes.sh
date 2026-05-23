#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "usage: $0 <version>" >&2
  echo "example: $0 v1.1.0" >&2
}

if [ "$#" -ne 1 ]; then
  usage
  exit 2
fi

version="${1#v}"
changelog_path="${CHANGELOG_PATH:-extension/CHANGELOG.md}"

if [ ! -f "$changelog_path" ]; then
  echo "release-notes: changelog not found: $changelog_path" >&2
  exit 1
fi

awk -v version="$version" '
  BEGIN {
    heading = "## " version
    in_section = 0
    found = 0
  }

  $0 == heading {
    in_section = 1
    found = 1
    next
  }

  in_section && /^## [^#]/ {
    exit
  }

  in_section {
    lines[++line_count] = $0
  }

  END {
    if (!found) {
      print "release-notes: version not found in changelog: " version > "/dev/stderr"
      exit 1
    }

    start = 1
    while (start <= line_count && lines[start] == "") {
      start++
    }

    end = line_count
    while (end >= start && lines[end] == "") {
      end--
    }

    for (i = start; i <= end; i++) {
      print lines[i]
    }
  }
' "$changelog_path"
