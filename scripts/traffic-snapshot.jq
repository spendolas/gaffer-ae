# One line of docs/traffic-snapshots.jsonl. Inputs (all via --arg/--argjson):
#   $ts        UTC timestamp string
#   $clones    GET repos/{repo}/traffic/clones
#   $views     GET repos/{repo}/traffic/views
#   $releases  every page of GET repos/{repo}/releases, merged into one array
# Drafts are left out. installs/updates sum download_count over the assets
# named gaffer-install-* and gaffer-update-* across all releases.
($releases
  | map(select(.draft | not))
  | map({tag: .tag_name, prerelease: .prerelease,
         assets: [.assets[] | {name, download_count}]})) as $r
| ([$r[].assets[]]) as $all
| {timestamp: $ts, clones: $clones, views: $views, releases: $r,
   installs: ([$all[] | select(.name | startswith("gaffer-install-")) | .download_count] | add // 0),
   updates: ([$all[] | select(.name | startswith("gaffer-update-")) | .download_count] | add // 0)}
