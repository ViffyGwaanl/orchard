"""Builds a small NoteStore.sqlite with the same shape as Apple Notes' database."""
import sqlite3, sys, gzip

def varint(n):
    out = bytearray()
    while True:
        b = n & 0x7f; n >>= 7
        out.append(b | (0x80 if n else 0))
        if not n: return bytes(out)

def ld(field, payload):
    return varint((field << 3) | 2) + varint(len(payload)) + payload

def note_blob(text):
    note = ld(2, text.encode()) + varint((3 << 3) | 0) + varint(1)   # note_text + an extra varint field
    doc = varint((2 << 3) | 0) + varint(0) + ld(3, note)
    return gzip.compress(varint((1 << 3) | 0) + varint(0) + ld(2, doc))

path = sys.argv[1]
con = sqlite3.connect(path)
c = con.cursor()
c.executescript("""
CREATE TABLE Z_PRIMARYKEY (Z_ENT INTEGER PRIMARY KEY, Z_NAME VARCHAR, Z_SUPER INTEGER, Z_MAX INTEGER);
CREATE TABLE Z_METADATA (Z_VERSION INTEGER PRIMARY KEY, Z_UUID VARCHAR(255), Z_PLIST BLOB);
CREATE TABLE ZICCLOUDSYNCINGOBJECT (Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, ZTITLE1 VARCHAR, ZSNIPPET VARCHAR,
  ZMODIFICATIONDATE1 TIMESTAMP, ZFOLDER INTEGER, ZNOTEDATA INTEGER, ZMARKEDFORDELETION INTEGER, ZISPASSWORDPROTECTED INTEGER,
  ZTITLE2 VARCHAR, ZOWNER INTEGER, ZNAME VARCHAR, ZFOLDERTYPE INTEGER);
CREATE TABLE ZICNOTEDATA (Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, ZNOTE INTEGER, ZDATA BLOB);
INSERT INTO Z_PRIMARYKEY VALUES (5,'ICAccount',0,0),(10,'ICFolder',0,0),(12,'ICNote',0,0);
INSERT INTO Z_METADATA VALUES (1,'E0423D34-TEST',NULL);
INSERT INTO ZICCLOUDSYNCINGOBJECT (Z_PK,Z_ENT,ZNAME) VALUES (1,5,'iCloud');
INSERT INTO ZICCLOUDSYNCINGOBJECT (Z_PK,Z_ENT,ZTITLE2,ZOWNER,ZFOLDERTYPE) VALUES (2,10,'Notes',1,0),(3,10,'提示词',1,0),(4,10,'Recently Deleted',1,1);
""")
notes = [
    (100, 'Shopping', 'Milk', 815000000, 2, 'Shopping\nMilk\nEggs and bread', 0, 0),
    (101, '会议纪要 10/15', '讨论 4K 导出', 814900000, 3, '会议纪要 10/15\n讨论 4K 导出方案，Fotor 档期改到 10.22', 0, 0),
    (102, 'Secret', '', 814800000, 2, 'Secret\ncipher', 0, 1),
    (103, 'Old trash', 'gone', 814700000, 4, 'Old trash\nFotor in trash', 0, 0),
    (104, 'Deleted flag', 'x', 814600000, 2, 'Deleted flag\nFotor', 1, 0),
]
for pk, title, snip, mod, folder, body, deleted, locked in notes:
    nd = pk + 1000
    c.execute('INSERT INTO ZICCLOUDSYNCINGOBJECT (Z_PK,Z_ENT,ZTITLE1,ZSNIPPET,ZMODIFICATIONDATE1,ZFOLDER,ZNOTEDATA,ZMARKEDFORDELETION,ZISPASSWORDPROTECTED) VALUES (?,?,?,?,?,?,?,?,?)',
              (pk, 12, title, snip, mod, folder, nd, deleted, locked))
    c.execute('INSERT INTO ZICNOTEDATA (Z_PK,Z_ENT,ZNOTE,ZDATA) VALUES (?,?,?,?)', (nd, 13, pk, b'\x00garbage' if locked else note_blob(body)))
con.commit()
