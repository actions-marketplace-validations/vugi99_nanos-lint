# ZIP fixtures produced by real writers

Committed byte-for-byte so the pre-extraction inspection is regression-tested against
archives it does not build itself. `tests/unit/validation-zip.test.ts` asserts the exact
member count and total declared size of each one.

| Fixture                     | Produced by                                                                                            | Covers                                                                             |
| --------------------------- | ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| `python-zipfile.zip`        | Python 3 `zipfile` (`ZIP_DEFLATED`, archive comment, one stored member, one `force_zip64=True` member) | ZIP64 extended information in the local header, archive comment, mixed compression |
| `python-datadescriptor.zip` | Python 3 `zipfile` over a non-seekable stream                                                          | data-descriptor flag in the local and central records                              |
| `infozip.zip`               | Info-ZIP `zip -r -z`                                                                                   | Info-ZIP extra fields (`0x5455`, `0x7875`), stored + deflated members              |

Totals reported by Python's `zipfile` reader (and asserted in the test):

| Fixture                     | Members | Total uncompressed bytes |
| --------------------------- | ------- | ------------------------ |
| `python-zipfile.zip`        | 3       | 302700                   |
| `python-datadescriptor.zip` | 1       | 150000                   |
| `infozip.zip`               | 3       | 132004                   |

Regenerate with:

```bash
python3 - <<'PY'
import zipfile

out = "tests/fixtures/zip"
with zipfile.ZipFile(f"{out}/python-zipfile.zip", "w", zipfile.ZIP_DEFLATED) as z:
    z.comment = b"nanos-lint fixture: python zipfile writer"
    z.writestr("bin/lua-language-server.exe", b"B" * 200000)
    z.writestr("bin/annotations.lua", b"return {}" * 300, zipfile.ZIP_STORED)
    info = zipfile.ZipInfo("bin/forced64.bin", (2024, 1, 1, 0, 0, 0))
    info.compress_type = zipfile.ZIP_DEFLATED
    with z.open(info, "w", force_zip64=True) as f:
        f.write(b"F" * 100000)


class NoSeek:
    def __init__(self, fh):
        self.fh = fh

    def write(self, b):
        return self.fh.write(b)

    def flush(self):
        self.fh.flush()

    def tell(self):
        raise OSError("not seekable")

    def seekable(self):
        return False


with open(f"{out}/python-datadescriptor.zip", "wb") as fh:
    with zipfile.ZipFile(NoSeek(fh), "w", zipfile.ZIP_DEFLATED) as z:
        z.comment = b"fixture: data descriptor"
        info = zipfile.ZipInfo("bin/streamed.bin", (2024, 1, 1, 0, 0, 0))
        info.compress_type = zipfile.ZIP_DEFLATED
        with z.open(info, "w") as f:
            f.write(b"S" * 150000)
PY

mkdir -p /tmp/fixture-src/bin
printf '\x7fELF' > /tmp/fixture-src/bin/lua-language-server.exe
head -c 120000 /dev/zero >> /tmp/fixture-src/bin/lua-language-server.exe
python3 -c "open('/tmp/fixture-src/bin/annotations.lua','wb').write(b'---@class Foo\nreturn {}\n' * 500)"
(cd /tmp/fixture-src && zip -q -r -z "$OLDPWD/tests/fixtures/zip/infozip.zip" . <<< "nanos-lint fixture: Info-ZIP writer")
```
