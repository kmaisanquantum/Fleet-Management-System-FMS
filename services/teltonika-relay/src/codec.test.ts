import { describe, it, expect } from "vitest";
import { CODEC_8, CODEC_8_EXTENDED, parseAvlPacket, encodeAvlPacket, crc16Arc } from "./codec";

/**
 * Known FMB125 AVL payloads (AVL data array: Codec ID through CRC-16), captured
 * in the shape emitted by a Teltonika FMB125 configured for Codec 8 / Codec 8
 * Extended.
 */
const CODEC_8_PAYLOAD_HEX =
  "08010000019D3419CF800157B9EE78FA5EFD90003400B409002DF80A0615051E44715CEF01F001F80C03240834425DC0430F3C011003010B0000010EC40000";

const CODEC_8E_PAYLOAD_HEX =
  "8E010000019D3419CF800157B9EE78FA5EFD90003400B409002DF00A000500150500715C009B0300EF0100F001000200425DC003FF032C0003001003010B000181000700A901850001E208000000000194080000";

describe("Teltonika AVL Codec 8 decoder", () => {
  it("decodes a known Codec 8 AVL payload", () => {
    const packet = parseAvlPacket(Buffer.from(CODEC_8_PAYLOAD_HEX, "hex"));

    expect(packet.codecId).toBe(CODEC_8);
    expect(packet.records).toHaveLength(1);

    const [rec] = packet.records;
    // 2026-03-28T11:00:00Z
    expect(rec.timestamp).toBe(1774695600000);
    expect(rec.priority).toBe(1);

    expect(rec.gps.lon).toBeCloseTo(147.1803, 6);
    expect(rec.gps.lat).toBeCloseTo(-9.4438, 6);
    expect(rec.gps.altitude).toBe(52);
    expect(rec.gps.angle).toBe(180);
    expect(rec.gps.satellites).toBe(9);
    expect(rec.gps.speed).toBe(45);

    // IO elements, including 1/2/4-byte groups
    expect(rec.io[239]).toBe(1); // ignition
    expect(rec.io[240]).toBe(1); // movement
    expect(rec.io[21]).toBe(5); // GSM signal
    expect(rec.io[66]).toBe(24000); // external voltage (mV)
    expect(rec.io[113]).toBe(92); // battery level %
    expect(rec.io[16]).toBe(50400000); // odometer (metres)
    expect(rec.io[36]).toBe(2100); // engine RPM
    expect(rec.io[248]).toBe(12); // harsh acceleration
  });

  it("decodes a Codec 8 Extended payload with 16-bit IO ids", () => {
    const packet = parseAvlPacket(Buffer.from(CODEC_8E_PAYLOAD_HEX, "hex"));

    expect(packet.codecId).toBe(CODEC_8_EXTENDED);
    expect(packet.records).toHaveLength(1);

    const [rec] = packet.records;
    expect(rec.gps.lat).toBeCloseTo(-9.4438, 6);
    expect(rec.gps.lon).toBeCloseTo(147.1803, 6);

    expect(rec.io[389]).toBe(123400); // trip odometer (metres)
    expect(rec.io[385]).toBe(458921); // BLE driver id
    expect(rec.io[155]).toBe(3); // geofence zone
    expect(rec.io[1023]).toBe(812); // engine hours
  });

  it("round-trips encoded records and computes a valid CRC-16", () => {
    const records = [
      {
        timestamp: 1774695600000,
        priority: 1,
        gps: { lon: 147.1803, lat: -9.4438, altitude: 52, angle: 180, satellites: 9, speed: 45 },
        eventIoId: 240,
        io: { 239: 1, 21: 5, 16: 50400000 },
      },
    ];

    const framed = encodeAvlPacket(records, CODEC_8);
    // Preamble + length framing
    expect(framed.readUInt32BE(0)).toBe(0);
    expect(framed.readUInt32BE(4)).toBe(framed.length - 8);

    const inner = framed.subarray(8);
    const declaredCrc = inner.readUInt16BE(inner.length - 4);
    expect(crc16Arc(inner.subarray(0, inner.length - 4))).toBe(declaredCrc);

    const decoded = parseAvlPacket(inner);
    expect(decoded.records[0].io[16]).toBe(50400000);
    expect(decoded.records[0].gps.speed).toBe(45);
  });

  it("rejects an unsupported codec id", () => {
    const bad = Buffer.from([0x0c, 0x01, 0x00, 0x00, 0x00]);
    expect(() => parseAvlPacket(bad)).toThrow(/Unsupported Teltonika codec/);
  });
});
