# 7-Zip reduced standalone build (7zr)

`7zr.exe` is the standalone "reduced" build of 7-Zip, version 26.04, downloaded
from <https://www.7-zip.org/a/7zr.exe>.

- Upstream: <https://www.7-zip.org/>
- Licence: public domain (7-Zip is distributed under the GNU LGPL; the `7zr`
  standalone build itself is released into the public domain by its author,
  Igor Pavlov — see the 7-Zip licence page above)
- Size: 602,624 bytes
- Capability: creates and extracts `.7z` archives, supports `-p` AES-256 with
  `-mhe=on` header encryption, and `-v` volume splitting

The plugin uses this binary only when the backup compression is set to 7z. zip
archives are written by the plugin itself, so a missing or blocked `7zr.exe`
degrades to "zip only" rather than failing a backup.

To replace it with a newer release, download the matching `7zr.exe` and
overwrite this file; the plugin resolves it from `bin/` next to `index.js`.
