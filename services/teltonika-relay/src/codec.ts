/**
 * Teltonika AVL protocol codec (Codec 8 / Codec 8 Extended).
 *
 * Implements the TCP framing and AVL data-array decoding used by Teltonika
 * FMB-series trackers (e.g. FMB125). See TELTONIKA_INTEGRATION.md for the
 * end-to-end architecture.
 *
 * Packet framing (after the IMEI handshake):
 *   [4 bytes] preamble          = 0x00000000
 *   [4 bytes] AVL data length   = length of everything from Codec ID through CRC-16
 *   [1 byte]  Codec ID          = 0x08 (Codec 8) | 0x8E (Codec 8 Extended)
 *   [1 byte]  Number of Data 1  = record count
 *   [...      ] AVL data records
 *   [1 byte]  Number of Data 2  = record count (repeat)
 *   [4 bytes] CRC-16
 */

export const CODEC_8 = 0x08;
export const CODEC_8_EXTENDED = 0x8e;

export interface GpsElement {
  /** Longitude in decimal degrees. */
  lon: number;
  /** Latitude in decimal degrees. */
  lat: number;
  /** Altitude in metres. */
  altitude: number;
  /** Heading / course in degrees. */
  angle: number;
  /** Number of visible satellites. */
  satellites: number;
  /** GPS ground speed in km/h. */
  speed: number;
}

export interface AvlRecord {
  /** Device timestamp in epoch milliseconds. */
  timestamp: number;
  /** AVL priority (0 low, 1 high, 2 panic). */
  priority: number;
  gps: GpsElement;
  /** Event IO id that triggered the record (255 = periodic, 0 = none). */
  eventIoId: number;
  /** Raw IO element values keyed by AVL IO id. */
  io: Record<string, number>;
}

export interface AvlPacket {
  codecId: number;
  records: AvlRecord[];
}

class Reader {
  private offset = 0;
  constructor(private readonly buf: Buffer) {}

  get remaining(): number {
    return this.buf.length - this.offset;
  }

  u8(): number {
    const v = this.buf.readUInt8(this.offset);
    this.offset += 1;
    return v;
  }

  i8(): number {
    const v = this.buf.readInt8(this.offset);
    this.offset += 1;
    return v;
  }

  u16(): number {
    const v = this.buf.readUInt16BE(this.offset);
    this.offset += 2;
    return v;
  }

  i16(): number {
    const v = this.buf.readInt16BE(this.offset);
    this.offset += 2;
    return v;
  }

  u32(): number {
    const v = this.buf.readUInt32BE(this.offset);
    this.offset += 4;
    return v;
  }

  i32(): number {
    const v = this.buf.readInt32BE(this.offset);
    this.offset += 4;
    return v;
  }

  u64(): number {
    const v = this.buf.readBigUInt64BE(this.offset);
    this.offset += 8;
    return Number(v);
  }

  bytes(n: number): Buffer {
    const v = this.buf.subarray(this.offset, this.offset + n);
    this.offset += n;
    return v;
  }
}

function readInteger(buf: Buffer): number {
  switch (buf.length) {
    case 1:
      return buf.readUInt8(0);
    case 2:
      return buf.readUInt16BE(0);
    case 4:
      return buf.readUInt32BE(0);
    case 8:
      return Number(buf.readBigUInt64BE(0));
    default:
      return 0;
  }
}

function readGpsElement(reader: Reader): GpsElement {
  return {
    lon: reader.i32() / 1e7,
    lat: reader.i32() / 1e7,
    altitude: reader.i16(),
    angle: reader.u16(),
    satellites: reader.u8(),
    speed: reader.u16(),
  };
}

/**
 * Reads the IO element block. In Codec 8 IO ids and group counts are 1 byte;
 * in Codec 8 Extended they are 2 bytes and an extra variable-length ("X")
 * group is present.
 */
function readIoElement(
  reader: Reader,
  extended: boolean
): { eventIoId: number; io: Record<string, number> } {
  const eventIoId = reader.u8();
  reader.u8(); // total IO count (informational)

  const io: Record<string, number> = {};
  const readCount = () => (extended ? reader.u16() : reader.u8());
  const readId = () => (extended ? reader.u16() : reader.u8());

  for (const size of [1, 2, 4, 8] as const) {
    const count = readCount();
    for (let i = 0; i < count; i++) {
      const id = readId();
      io[id] = readInteger(reader.bytes(size));
    }
  }

  if (extended) {
    const xCount = readCount();
    for (let i = 0; i < xCount; i++) {
      const id = reader.u16();
      const length = reader.u16();
      io[id] = readInteger(reader.bytes(length));
    }
  }

  return { eventIoId, io };
}

function readAvlRecord(reader: Reader, extended: boolean): AvlRecord {
  const timestamp = reader.u64();
  const priority = reader.u8();
  const gps = readGpsElement(reader);
  const { eventIoId, io } = readIoElement(reader, extended);
  return { timestamp, priority, gps, eventIoId, io };
}

/**
 * Decodes an AVL data array (everything after the preamble + length fields,
 * i.e. Codec ID through CRC-16).
 */
export function parseAvlPacket(data: Buffer): AvlPacket {
  const reader = new Reader(data);
  const codecId = reader.u8();

  if (codecId !== CODEC_8 && codecId !== CODEC_8_EXTENDED) {
    throw new Error(`Unsupported Teltonika codec id: 0x${codecId.toString(16)}`);
  }

  const extended = codecId === CODEC_8_EXTENDED;
  const recordCount = reader.u8();
  const records: AvlRecord[] = [];
  for (let i = 0; i < recordCount; i++) {
    records.push(readAvlRecord(reader, extended));
  }

  // Trailing record count + CRC-16 (not validated; some firmware revisions
  // compute CRC differently and it is not required for ingest).
  reader.remaining >= 1 && reader.u8();
  reader.remaining >= 4 && reader.u32();

  if (records.length !== recordCount) {
    throw new Error(`Record count mismatch: header=${recordCount} parsed=${records.length}`);
  }

  return { codecId, records };
}

/**
 * Encodes records as a framed AVL packet (preamble + length + array + CRC).
 * Used by tests and tooling to synthesise FMB125-shaped payloads.
 *
 * Note: IO ids greater than 255 (e.g. trip odometer 389, BLE driver id 385)
 * can only be represented in Codec 8 Extended.
 */
export function encodeAvlPacket(records: AvlRecord[], codecId: number = CODEC_8): Buffer {
  const extended = codecId === CODEC_8_EXTENDED;
  const idSize = extended ? 2 : 1;
  const countSize = extended ? 2 : 1;

  const parts: Buffer[] = [];
  for (const r of records) {
    const head = Buffer.alloc(9 + 15);
    head.writeBigUInt64BE(BigInt(Math.round(r.timestamp)), 0);
    head.writeUInt8(r.priority, 8);
    let o = 9;
    head.writeInt32BE(Math.round(r.gps.lon * 1e7), o);
    o += 4;
    head.writeInt32BE(Math.round(r.gps.lat * 1e7), o);
    o += 4;
    head.writeInt16BE(r.gps.altitude, o);
    o += 2;
    head.writeUInt16BE(r.gps.angle, o);
    o += 2;
    head.writeUInt8(r.gps.satellites, o);
    o += 1;
    head.writeUInt16BE(r.gps.speed, o);
    o += 2;
    parts.push(head);

    const ids = Object.keys(r.io).map((k) => Number(k));
    const groups: Record<number, number[]> = { 1: [], 2: [], 4: [], 8: [] };
    for (const id of ids) {
      if (!extended && id > 0xff) {
        throw new Error(`IO id ${id} requires Codec 8 Extended (0x8E)`);
      }
      const value = r.io[id];
      if (value <= 0xff) groups[1].push(id);
      else if (value <= 0xffff) groups[2].push(id);
      else if (value <= 0xffffffff) groups[4].push(id);
      else groups[8].push(id);
    }

    const ioParts: Buffer[] = [];
    ioParts.push(Buffer.from([r.eventIoId, ids.length]));
    const writeId = (id: number) => {
      const b = Buffer.alloc(idSize);
      b.writeUIntBE(id, 0, idSize);
      return b;
    };
    for (const size of [1, 2, 4, 8]) {
      const groupIds = groups[size];
      const cnt = Buffer.alloc(countSize);
      cnt.writeUIntBE(groupIds.length, 0, countSize);
      ioParts.push(cnt);
      for (const id of groupIds) {
        const valBuf = Buffer.alloc(size);
        valBuf.writeUIntBE(r.io[id], 0, size);
        ioParts.push(writeId(id), valBuf);
      }
    }
    if (extended) {
      const xCnt = Buffer.alloc(countSize);
      xCnt.writeUIntBE(0, 0, countSize);
      ioParts.push(xCnt);
    }
    parts.push(Buffer.concat(ioParts));
  }

  const body = Buffer.concat(parts);
  const withHeader = Buffer.concat([
    Buffer.from([codecId, records.length]),
    body,
    Buffer.from([records.length]),
  ]);
  // CRC-16 appended over the array (ingest does not validate it).
  const crc = Buffer.alloc(4);
  crc.writeUInt16BE(crc16Arc(withHeader), 0);

  const inner = Buffer.concat([withHeader, crc]);
  const preambleAndLength = Buffer.alloc(8);
  preambleAndLength.writeUInt32BE(0, 0);
  preambleAndLength.writeUInt32BE(inner.length, 4);
  return Buffer.concat([preambleAndLength, inner]);
}

/** CRC-16/ARC (polynomial 0xA001) as used by the Teltonika protocol. */
export function crc16Arc(buf: Buffer): number {
  let crc = 0;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) {
      if (crc & 1) crc = (crc >> 1) ^ 0xa001;
      else crc >>= 1;
    }
  }
  return crc & 0xffff;
}
