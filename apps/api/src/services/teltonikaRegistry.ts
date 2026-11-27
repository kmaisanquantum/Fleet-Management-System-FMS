/**
 * Teltonika FMB125 parameter registry.
 *
 * One central dictionary drives the Configurator-style workspace, the Codec 12
 * `getparam` / `setparam` mapping, and profile import/export. Parameter IDs and
 * ranges follow the FMB125 parameter list (firmware 03.25.x). Keep this file as
 * the single source of truth; the API exposes it at `GET /api/devices/registry`.
 */

export type TeltonikaFieldType = "number" | "text" | "select" | "boolean" | "time" | "password" | "readonly";

export interface TeltonikaOption {
  value: string;
  label: string;
}

export interface TeltonikaField {
  id: string;
  paramId: number;
  label: string;
  category: string;
  subSection: string;
  type: TeltonikaFieldType;
  options?: TeltonikaOption[];
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  placeholder?: string;
  help?: string;
  defaultValue?: string;
  dangerous?: boolean;
  sensitive?: boolean;
  /** Parameters read by "Load from device" when no explicit list is supplied. */
  loadByDefault?: boolean;
}

export interface TeltonikaFeature {
  key: string;
  label: string;
  description: string;
  fields: TeltonikaField[];
}

export interface TeltonikaSection {
  key: string;
  label: string;
  description: string;
  kind: "status" | "parameters";
  fields: TeltonikaField[];
  features?: TeltonikaFeature[];
}

const PRIORITY: TeltonikaOption[] = [
  { value: "0", label: "Disable" },
  { value: "1", label: "Low Priority" },
  { value: "2", label: "High Priority" },
  { value: "3", label: "Panic Priority" },
];

const OUTPUT_NONE_DOUT1: TeltonikaOption[] = [
  { value: "0", label: "None" },
  { value: "1", label: "DOUT 1" },
];

const ENABLE: TeltonikaOption[] = [
  { value: "0", label: "Disable" },
  { value: "1", label: "Enable" },
];

const DISABLE_ENABLE: TeltonikaOption[] = [
  { value: "0", label: "Disabled" },
  { value: "1", label: "Enabled" },
];

const AUTH_CHECK: TeltonikaOption[] = [
  { value: "0", label: "None" },
  { value: "1", label: "OneWire" },
  { value: "2", label: "Beacon" },
  { value: "3", label: "Both" },
];

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

function field(
  category: string,
  subSection: string,
  paramId: number,
  label: string,
  type: TeltonikaFieldType,
  extra: Partial<TeltonikaField> = {}
): TeltonikaField {
  return {
    id: `${slug(category)}-${slug(subSection)}-${paramId}-${slug(label)}`,
    paramId,
    label,
    category,
    subSection,
    type,
    loadByDefault: true,
    ...extra,
  };
}

function scenario(category: string, subSection: string, paramId: number): TeltonikaField {
  return field(category, subSection, paramId, "Scenario Settings", "select", { options: PRIORITY, defaultValue: "0" });
}

function outputControl(category: string, subSection: string, paramId: number, label = "Output Control"): TeltonikaField {
  return field(category, subSection, paramId, label, "select", { options: OUTPUT_NONE_DOUT1, defaultValue: "0" });
}

function eventualRecords(category: string, subSection: string, paramId: number): TeltonikaField {
  return field(category, subSection, paramId, "Eventual Records", "select", { options: ENABLE, defaultValue: "0" });
}

function doutOn(category: string, subSection: string, paramId: number): TeltonikaField {
  return field(category, subSection, paramId, "DOUT ON Duration", "number", {
    min: 100,
    max: 5000,
    unit: "ms",
    defaultValue: "200",
  });
}

function doutOff(category: string, subSection: string, paramId: number): TeltonikaField {
  return field(category, subSection, paramId, "DOUT OFF Duration", "number", {
    min: 0,
    max: 5000,
    unit: "ms",
    defaultValue: "200",
  });
}

function smsTo(category: string, subSection: string, paramId: number): TeltonikaField {
  return field(category, subSection, paramId, "Send SMS to", "text", { placeholder: "GSM number index (0–10)" });
}

function smsText(category: string, subSection: string, paramId: number): TeltonikaField {
  return field(category, subSection, paramId, "SMS Text", "text", { placeholder: "Message text" });
}

function numberField(
  category: string,
  subSection: string,
  paramId: number,
  label: string,
  extra: Partial<TeltonikaField> = {}
): TeltonikaField {
  return field(category, subSection, paramId, label, "number", extra);
}

function selectField(
  category: string,
  subSection: string,
  paramId: number,
  label: string,
  options: TeltonikaOption[],
  extra: Partial<TeltonikaField> = {}
): TeltonikaField {
  return field(category, subSection, paramId, label, "select", { options, ...extra });
}

function textField(
  category: string,
  subSection: string,
  paramId: number,
  label: string,
  extra: Partial<TeltonikaField> = {}
): TeltonikaField {
  return field(category, subSection, paramId, label, "text", extra);
}

/* -------------------------------------------------------------------------- */
/* Features (default card grid)                                                */
/* -------------------------------------------------------------------------- */

const FEATURES = "Features";

const overspeeding: TeltonikaFeature = {
  key: "overspeeding",
  label: "Overspeeding",
  description: "Speed threshold, priority, output pulse, and SMS notification.",
  fields: [
    scenario(FEATURES, "Overspeeding", 11100),
    numberField(FEATURES, "Overspeeding", 11104, "Max Speed", { min: 0, max: 260, unit: "km/h", defaultValue: "90" }),
    outputControl(FEATURES, "Overspeeding", 11103),
    doutOn(FEATURES, "Overspeeding", 11101),
    doutOff(FEATURES, "Overspeeding", 11102),
    smsTo(FEATURES, "Overspeeding", 7032),
    smsText(FEATURES, "Overspeeding", 8032),
  ],
};

const immobilizer: TeltonikaFeature = {
  key: "immobilizer",
  label: "Immobilizer",
  description: "Authorization checks, ignition-off timeout, output control, and SMS.",
  fields: [
    scenario(FEATURES, "Immobilizer", 11700),
    eventualRecords(FEATURES, "Immobilizer", 11701),
    outputControl(FEATURES, "Immobilizer", 11702, "Immobilizer Output Control"),
    selectField(FEATURES, "Immobilizer", 11703, "Authorization ID List Checking", AUTH_CHECK, {
      help: "Firmware 03.25.x exposes 0/1; Beacon/Both require a beacon-capable firmware.",
    }),
    smsTo(FEATURES, "Immobilizer", 7140),
    smsText(FEATURES, "Immobilizer", 8140),
    numberField(FEATURES, "Immobilizer", 60068, "Ignition OFF Timeout", {
      min: 1,
      max: 65535,
      unit: "s",
      defaultValue: "30",
    }),
  ],
};

const fuelCounter: TeltonikaFeature = {
  key: "gnss-fuel-counter",
  label: "GNSS Fuel Counter",
  description: "Consumption model used by the tracker's GNSS fuel counter.",
  fields: [
    numberField(FEATURES, "GNSS Fuel Counter", 11900, "City Consumption", { min: 0, max: 50, step: 0.1, unit: "L/100km" }),
    numberField(FEATURES, "GNSS Fuel Counter", 11901, "Highway Consumption", { min: 0, max: 50, step: 0.1, unit: "L/100km" }),
    numberField(FEATURES, "GNSS Fuel Counter", 11902, "Average Consumption", { min: 0, max: 50, step: 0.1, unit: "L/100km" }),
    numberField(FEATURES, "GNSS Fuel Counter", 11903, "City Speed", { min: 0, max: 250, unit: "km/h", defaultValue: "30" }),
    numberField(FEATURES, "GNSS Fuel Counter", 11904, "Highway Speed", { min: 0, max: 250, unit: "km/h", defaultValue: "90" }),
    numberField(FEATURES, "GNSS Fuel Counter", 11905, "Average Speed", { min: 0, max: 250, unit: "km/h", defaultValue: "60" }),
    numberField(FEATURES, "GNSS Fuel Counter", 11906, "Correction Coefficient", { min: 0.01, max: 2, step: 0.01, defaultValue: "1" }),
    numberField(FEATURES, "GNSS Fuel Counter", 11907, "Fuel Consumption on Idling", { min: 0, max: 5, step: 0.01, unit: "L/h", defaultValue: "1" }),
    numberField(FEATURES, "GNSS Fuel Counter", 11908, "Higher Speeds Add", { min: 0, max: 250, unit: "%", defaultValue: "20" }),
    numberField(FEATURES, "GNSS Fuel Counter", 11909, "Highway Consumption Every", { min: 0, max: 100, unit: "km/h", defaultValue: "50" }),
  ],
};

const jamming: TeltonikaFeature = {
  key: "network-jamming",
  label: "Network Jamming",
  description: "Detect GSM jamming and raise an event or output pulse.",
  fields: [
    scenario(FEATURES, "Network Jamming", 11300),
    eventualRecords(FEATURES, "Network Jamming", 11303),
    outputControl(FEATURES, "Network Jamming", 11304),
    doutOn(FEATURES, "Network Jamming", 11301),
    doutOff(FEATURES, "Network Jamming", 11302),
    numberField(FEATURES, "Network Jamming", 11305, "Time Until Jamming Event Detection", {
      min: 0,
      max: 65535,
      unit: "s",
      defaultValue: "60",
    }),
  ],
};

const ibutton: TeltonikaFeature = {
  key: "ibutton-read-notification",
  label: "iButton Read Notification",
  description: "Green output pulse and authorization list behaviour for iButton reads.",
  fields: [
    outputControl(FEATURES, "iButton Read Notification", 11704, "Green Output Control"),
    numberField(FEATURES, "iButton Read Notification", 11705, "DOUT ON Duration", {
      min: 100,
      max: 50000,
      unit: "ms",
      defaultValue: "200",
    }),
    selectField(FEATURES, "iButton Read Notification", 11706, "List Checking For Authorization", ENABLE),
    selectField(FEATURES, "iButton Read Notification", 11707, "Ignition tmo", ENABLE),
  ],
};

const doutIgnition: TeltonikaFeature = {
  key: "dout-control-via-ignition",
  label: "DOUT Control Via Ignition",
  description: "Drive DOUT1 from ignition state and deactivate it from a digital input.",
  fields: [
    outputControl(FEATURES, "DOUT Control Via Ignition", 12000),
    selectField(FEATURES, "DOUT Control Via Ignition", 12001, "DOUT Deactivation Via DIN", [
      { value: "0", label: "None" },
      { value: "1", label: "DIN 1" },
    ]),
    numberField(FEATURES, "DOUT Control Via Ignition", 12002, "Ignition OFF Timeout", {
      min: 0,
      max: 2147483647,
      unit: "s",
      defaultValue: "5",
    }),
  ],
};

/* -------------------------------------------------------------------------- */
/* Accelerometer features                                                      */
/* -------------------------------------------------------------------------- */

const ACC = "Accelerometer Features";

const accelerometerFeatures: TeltonikaFeature[] = [
  {
    key: "unplug-detection",
    label: "Unplug Detection",
    description: "Detect tracker power disconnection.",
    fields: [
      scenario(ACC, "Unplug Detection", 11500),
      eventualRecords(ACC, "Unplug Detection", 11501),
      selectField(ACC, "Unplug Detection", 11502, "Detection Mode", [
        { value: "0", label: "Simple" },
        { value: "1", label: "Advanced" },
      ], { defaultValue: "1" }),
      smsTo(ACC, "Unplug Detection", 7036),
      smsText(ACC, "Unplug Detection", 8036),
    ],
  },
  {
    key: "towing-detection",
    label: "Towing Detection",
    description: "Detect unauthorised vehicle movement while parked.",
    fields: [
      scenario(ACC, "Towing Detection", 11600),
      eventualRecords(ACC, "Towing Detection", 11601),
      numberField(ACC, "Towing Detection", 11602, "Activation Timeout", { min: 0, max: 65535, unit: "min", defaultValue: "5" }),
      numberField(ACC, "Towing Detection", 11603, "Event Timeout", { min: 0, max: 60, unit: "s" }),
      numberField(ACC, "Towing Detection", 11604, "Make Call To", { min: 0, max: 10 }),
      numberField(ACC, "Towing Detection", 11605, "Threshold", { min: 0.1, max: 5, step: 0.01, unit: "mG", defaultValue: "0.22" }),
      numberField(ACC, "Towing Detection", 11606, "Angle", { min: 0.1, max: 5, step: 0.1, unit: "°", defaultValue: "1" }),
      numberField(ACC, "Towing Detection", 11607, "Duration", { min: 1, max: 5000, unit: "ms", defaultValue: "1000" }),
      smsTo(ACC, "Towing Detection", 7035),
      smsText(ACC, "Towing Detection", 8035),
    ],
  },
  {
    key: "crash-detection",
    label: "Crash Detection",
    description: "Accelerometer crash threshold and trace capture.",
    fields: [
      scenario(ACC, "Crash Detection", 11400),
      numberField(ACC, "Crash Detection", 11401, "Duration", { min: 0, max: 1000, unit: "ms", defaultValue: "5" }),
      numberField(ACC, "Crash Detection", 11402, "Threshold", { min: 0, max: 7900, unit: "mG", defaultValue: "1500" }),
      selectField(ACC, "Crash Detection", 11406, "Crash Trace", ENABLE),
      smsTo(ACC, "Crash Detection", 7037),
      smsText(ACC, "Crash Detection", 8037),
    ],
  },
  {
    key: "excessive-idling",
    label: "Excessive Idling",
    description: "Detect stationary engine-on periods.",
    fields: [
      scenario(ACC, "Excessive Idling", 11200),
      eventualRecords(ACC, "Excessive Idling", 11203),
      numberField(ACC, "Excessive Idling", 11205, "Time to Stopped", { min: 0, max: 3600, unit: "s", defaultValue: "5" }),
      numberField(ACC, "Excessive Idling", 11206, "Time to Moving", { min: 0, max: 3600, unit: "s", defaultValue: "2" }),
      outputControl(ACC, "Excessive Idling", 11204),
      doutOn(ACC, "Excessive Idling", 11201),
      doutOff(ACC, "Excessive Idling", 11202),
      smsTo(ACC, "Excessive Idling", 7033),
      smsText(ACC, "Excessive Idling", 8033),
    ],
  },
  {
    key: "motorcycle-fall",
    label: "Motorcycle Fall Detection",
    description: "Fall angle and alarm timing.",
    fields: [
      scenario(ACC, "Motorcycle Fall Detection", 13700),
      numberField(ACC, "Motorcycle Fall Detection", 13701, "Angle Value", { min: 30, max: 150, unit: "°", defaultValue: "45" }),
      numberField(ACC, "Motorcycle Fall Detection", 13702, "Alarm Delay", { min: 0, max: 60, unit: "s", defaultValue: "5" }),
      numberField(ACC, "Motorcycle Fall Detection", 13703, "Active Time", { min: 0, max: 65500, unit: "s", defaultValue: "15" }),
      outputControl(ACC, "Motorcycle Fall Detection", 13704),
      numberField(ACC, "Motorcycle Fall Detection", 13705, "DOUT ON Duration", { min: 100, max: 2147483647, unit: "ms", defaultValue: "200" }),
      numberField(ACC, "Motorcycle Fall Detection", 13706, "DOUT OFF Duration", { min: 0, max: 2147483647, unit: "ms", defaultValue: "200" }),
      smsTo(ACC, "Motorcycle Fall Detection", 7585),
      smsText(ACC, "Motorcycle Fall Detection", 8585),
    ],
  },
];

/* -------------------------------------------------------------------------- */
/* Remaining Configurator sections                                             */
/* -------------------------------------------------------------------------- */

const SYSTEM = "System";

const systemFields: TeltonikaField[] = [
  selectField(SYSTEM, "System Settings", 138, "Movement Source", [
    { value: "1", label: "Ignition" },
    { value: "2", label: "Accelerometer" },
    { value: "4", label: "GNSS" },
    { value: "8", label: "CAN Speed" },
  ], { defaultValue: "2" }),
  selectField(SYSTEM, "System Settings", 133, "Speed Source", [
    { value: "0", label: "GNSS" },
    { value: "1", label: "OBD / CAN" },
  ]),
  selectField(SYSTEM, "System Settings", 106, "Static Navigation", ENABLE, { defaultValue: "1" }),
  selectField(SYSTEM, "System Settings", 112, "Static Navigation Source", [
    { value: "1", label: "Movement" },
    { value: "2", label: "Ignition" },
  ], { defaultValue: "2" }),
  selectField(SYSTEM, "System Settings", 107, "Send/Save Records Without TS", [
    { value: "0", label: "After Position Fix" },
    { value: "1", label: "Always" },
    { value: "2", label: "After Time Sync" },
  ], { defaultValue: "2" }),
  selectField(SYSTEM, "System Settings", 108, "LED Indication", ENABLE, { defaultValue: "1" }),
  selectField(SYSTEM, "System Settings", 109, "GNSS Source", [
    { value: "1", label: "Beidou only" },
    { value: "2", label: "Glonass only" },
    { value: "4", label: "Galileo only" },
    { value: "8", label: "GPS only" },
    { value: "10", label: "GPS + Glonass" },
    { value: "12", label: "GPS + Galileo" },
    { value: "14", label: "GPS + Galileo + Glonass" },
    { value: "15", label: "All constellations" },
  ], { defaultValue: "10" }),
  selectField(SYSTEM, "System Settings", 110, "Battery Charge Mode", [
    { value: "0", label: "On need" },
    { value: "1", label: "After ignition on" },
    { value: "2", label: "Always" },
  ]),
  selectField(SYSTEM, "System Settings", 111, "Analog Input Value Range", [
    { value: "0", label: "Range 10V" },
    { value: "1", label: "Range 30V" },
  ], { defaultValue: "1" }),
  selectField(SYSTEM, "System Settings", 113, "Data Protocol", [
    { value: "0", label: "Codec 8" },
    { value: "1", label: "Codec 8 Extended" },
    { value: "2", label: "Codec JSON" },
  ], { defaultValue: "1" }),
  selectField(SYSTEM, "Sleep Mode", 102, "Sleep Settings", [
    { value: "0", label: "Disable" },
    { value: "1", label: "GPS sleep" },
    { value: "2", label: "Deep sleep" },
    { value: "3", label: "Online Deep sleep" },
    { value: "4", label: "Ultra Deep sleep" },
  ], { defaultValue: "2" }),
  numberField(SYSTEM, "Sleep Mode", 103, "Timeout", { min: 1, max: 3000, unit: "min", defaultValue: "1" }),
  selectField(SYSTEM, "Sleep Mode", 233, "1-Wire Enabled in DS and ODS", ENABLE),
  numberField(SYSTEM, "Ignition Source", 1000, "Ignition Source", {
    min: 0,
    max: 100,
    help: "Wiring-specific value. Verify before writing.",
    dangerous: true,
  }),
  selectField(SYSTEM, "Inputs", 135, "Input Mode", [
    { value: "0", label: "DIN2 / AIN1" },
    { value: "1", label: "Ground Sense" },
  ]),
  selectField(SYSTEM, "Inputs", 145, "Advance Pulse Counters", [
    { value: "0", label: "Disable" },
    { value: "1", label: "DIN2" },
  ]),
];

const GPRS = "GPRS";

const gprsFields: TeltonikaField[] = [
  selectField(GPRS, "GPRS Context", 2000, "GPRS Context", ENABLE, { defaultValue: "1" }),
  textField(GPRS, "Server", 2001, "APN", { dangerous: true, help: "Changing APN can disconnect the tracker from MeshSat." }),
  textField(GPRS, "Server", 2002, "APN Username", { dangerous: true }),
  textField(GPRS, "Server", 2003, "APN Password", { type: "password", sensitive: true, dangerous: true }),
  textField(GPRS, "Server", 2004, "Domain", { dangerous: true }),
  numberField(GPRS, "Server", 2005, "Port", { min: 0, max: 65535, dangerous: true }),
  selectField(GPRS, "Server", 2006, "Protocol", [
    { value: "0", label: "TCP" },
    { value: "1", label: "UDP" },
    { value: "3", label: "MQTT" },
  ], { dangerous: true }),
  selectField(GPRS, "Server", 2020, "TLS Encryption", ENABLE, { dangerous: true }),
  selectField(GPRS, "Backup Server", 2010, "Backup Server Mode", [
    { value: "0", label: "Disable" },
    { value: "1", label: "Backup" },
    { value: "2", label: "Duplicate" },
    { value: "3", label: "EGTS" },
  ]),
  textField(GPRS, "Backup Server", 2007, "Backup Server Domain", { dangerous: true }),
  numberField(GPRS, "Backup Server", 2008, "Backup Server Port", { min: 0, max: 65535, dangerous: true }),
  selectField(GPRS, "Backup Server", 2009, "Backup Server Protocol", [
    { value: "0", label: "TCP" },
    { value: "1", label: "UDP" },
    { value: "3", label: "MQTT" },
  ], { dangerous: true }),
  selectField(GPRS, "Connection", 2025, "Auto APN Search", ENABLE, { defaultValue: "1" }),
  numberField(GPRS, "Timeouts", 1000, "Open Link Timeout", { min: 30, max: 259200, unit: "s", defaultValue: "300" }),
  numberField(GPRS, "Timeouts", 1001, "Response Timeout", { min: 5, max: 300, unit: "s", defaultValue: "30" }),
  numberField(GPRS, "Timeouts", 1003, "Network Ping Timeout", { min: 0, max: 300, unit: "s" }),
  selectField(GPRS, "Timeouts", 1004, "ACK Type", [
    { value: "0", label: "TCP/IP" },
    { value: "1", label: "AVL" },
  ], { defaultValue: "1" }),
];

const DATA_ACQ = "Data Acquisition";

const dataAcquisitionFields: TeltonikaField[] = [
  numberField(DATA_ACQ, "Home — Vehicle on STOP", 10000, "Min Period", { min: 0, max: 2592000, unit: "s", defaultValue: "3600" }),
  numberField(DATA_ACQ, "Home — Vehicle on STOP", 10004, "Min Saved Records", { min: 1, max: 255, defaultValue: "1" }),
  numberField(DATA_ACQ, "Home — Vehicle on STOP", 10005, "Send Period", { min: 0, max: 2592000, unit: "s", defaultValue: "120" }),
  numberField(DATA_ACQ, "Home — Vehicle MOVING", 10050, "Min Period", { min: 0, max: 2592000, unit: "s", defaultValue: "300" }),
  numberField(DATA_ACQ, "Home — Vehicle MOVING", 10051, "Min Distance", { min: 0, max: 65535, unit: "m", defaultValue: "100" }),
  numberField(DATA_ACQ, "Home — Vehicle MOVING", 10052, "Min Angle", { min: 0, max: 180, unit: "°", defaultValue: "10" }),
  numberField(DATA_ACQ, "Home — Vehicle MOVING", 10053, "Min Speed Delta", { min: 0, max: 100, unit: "km/h", defaultValue: "10" }),
  numberField(DATA_ACQ, "Home — Vehicle MOVING", 10054, "Min Saved Records", { min: 1, max: 255, defaultValue: "1" }),
  numberField(DATA_ACQ, "Home — Vehicle MOVING", 10055, "Send Period", { min: 0, max: 2592000, unit: "s", defaultValue: "120" }),
  numberField(DATA_ACQ, "Roaming — Vehicle on STOP", 10100, "Min Period", { min: 0, max: 2592000, unit: "s", defaultValue: "3600" }),
  numberField(DATA_ACQ, "Roaming — Vehicle on STOP", 10104, "Min Saved Records", { min: 1, max: 255, defaultValue: "1" }),
  numberField(DATA_ACQ, "Roaming — Vehicle on STOP", 10105, "Send Period", { min: 0, max: 2592000, unit: "s" }),
  numberField(DATA_ACQ, "Roaming — Vehicle MOVING", 10150, "Min Period", { min: 0, max: 2592000, unit: "s", defaultValue: "300" }),
  numberField(DATA_ACQ, "Roaming — Vehicle MOVING", 10151, "Min Distance", { min: 0, max: 65535, unit: "m", defaultValue: "100" }),
  numberField(DATA_ACQ, "Roaming — Vehicle MOVING", 10152, "Min Angle", { min: 0, max: 180, unit: "°", defaultValue: "10" }),
  numberField(DATA_ACQ, "Roaming — Vehicle MOVING", 10153, "Min Speed Delta", { min: 0, max: 100, unit: "km/h", defaultValue: "10" }),
  numberField(DATA_ACQ, "Roaming — Vehicle MOVING", 10154, "Min Saved Records", { min: 1, max: 255, defaultValue: "1" }),
  numberField(DATA_ACQ, "Roaming — Vehicle MOVING", 10155, "Send Period", { min: 0, max: 2592000, unit: "s" }),
  numberField(DATA_ACQ, "Unknown — Vehicle on STOP", 10200, "Min Period", { min: 0, max: 2592000, unit: "s", defaultValue: "3600" }),
  numberField(DATA_ACQ, "Unknown — Vehicle on STOP", 10204, "Min Saved Records", { min: 1, max: 255, defaultValue: "1" }),
  numberField(DATA_ACQ, "Unknown — Vehicle on STOP", 10205, "Send Period", { min: 0, max: 2592000, unit: "s", defaultValue: "120" }),
  numberField(DATA_ACQ, "Unknown — Vehicle MOVING", 10250, "Min Period", { min: 0, max: 2592000, unit: "s", defaultValue: "300" }),
  numberField(DATA_ACQ, "Unknown — Vehicle MOVING", 10251, "Min Distance", { min: 0, max: 65535, unit: "m", defaultValue: "100" }),
  numberField(DATA_ACQ, "Unknown — Vehicle MOVING", 10252, "Min Angle", { min: 0, max: 180, unit: "°", defaultValue: "10" }),
  numberField(DATA_ACQ, "Unknown — Vehicle MOVING", 10253, "Min Speed Delta", { min: 0, max: 100, unit: "km/h", defaultValue: "10" }),
  numberField(DATA_ACQ, "Unknown — Vehicle MOVING", 10254, "Min Saved Records", { min: 1, max: 255, defaultValue: "1" }),
  numberField(DATA_ACQ, "Unknown — Vehicle MOVING", 10255, "Send Period", { min: 0, max: 2592000, unit: "s" }),
];

const SMS_CALL = "SMS / Call Settings";

const smsCallFields: TeltonikaField[] = [
  selectField(SMS_CALL, "SMS", 3000, "Allow SMS Data Sending", ENABLE),
  textField(SMS_CALL, "SMS", 3001, "Data Send Number", { placeholder: "Up to 16 characters" }),
  selectField(SMS_CALL, "Call", 3005, "Incoming Call Action", [
    { value: "0", label: "Do nothing" },
    { value: "1", label: "Hangup" },
    { value: "2", label: "Report position" },
    { value: "4", label: "Auto answer" },
  ]),
  selectField(SMS_CALL, "Call", 3007, "Outgoing Call Trigger", [
    { value: "0", label: "Disable" },
    { value: "1", label: "DIN1" },
    { value: "2", label: "Crash event" },
    { value: "3", label: "DIN1 and Crash event" },
    { value: "4", label: "DIN2" },
  ]),
  numberField(SMS_CALL, "Call", 3008, "GSM Number Index", { min: 0, max: 10 }),
  selectField(SMS_CALL, "Time", 3006, "SMS Event Time Zone", [
    { value: "0", label: "UTC+00:00" },
    { value: "120", label: "UTC+02:00" },
    { value: "180", label: "UTC+03:00" },
    { value: "-300", label: "UTC-05:00" },
  ], { help: "Raw minutes offset from UTC." }),
];

const GSM = "GSM Operators";

const gsmFields: TeltonikaField[] = [
  textField(GSM, "Operator Lists", 5000, "SIM1 Roaming Operator List", { placeholder: "MCC/MNC, comma separated" }),
  textField(GSM, "Operator Lists", 5500, "Operator Blacklist", { placeholder: "MCC/MNC, comma separated" }),
  textField(GSM, "Predefined Numbers", 6000, "Predefined Number", { placeholder: "Up to 16 characters" }),
  selectField(GSM, "Ban List", 2018, "Ban List Control", ENABLE),
];

const AUTO_GEOFENCE = "Auto Geofence";

const autoGeofenceFields: TeltonikaField[] = [
  scenario(AUTO_GEOFENCE, "Auto Geofence", 20000),
  eventualRecords(AUTO_GEOFENCE, "Auto Geofence", 20002),
  numberField(AUTO_GEOFENCE, "Auto Geofence", 20003, "Activation Timeout", { min: 0, max: 65535, unit: "s", defaultValue: "60" }),
  selectField(AUTO_GEOFENCE, "Auto Geofence", 20001, "AutoGeofence Event Generating", [
    { value: "0", label: "On exiting zone" },
    { value: "1", label: "On entering zone" },
    { value: "2", label: "On both" },
  ]),
  selectField(AUTO_GEOFENCE, "Auto Geofence", 20005, "Deactivate by", [
    { value: "0", label: "Power voltage" },
    { value: "1", label: "Digital input 1" },
    { value: "2", label: "Engine RPM" },
    { value: "3", label: "Digital input 2" },
    { value: "4", label: "Digital input 3" },
    { value: "5", label: "iButton" },
  ]),
  numberField(AUTO_GEOFENCE, "Auto Geofence", 20004, "Radius", { min: 5, max: 1000000, unit: "m", defaultValue: "100" }),
  smsTo(AUTO_GEOFENCE, "Auto Geofence", 7030),
  smsText(AUTO_GEOFENCE, "Auto Geofence", 8030),
];

const MANUAL_GEOFENCE = "Manual Geofence";

const manualGeofenceFields: TeltonikaField[] = [
  scenario(MANUAL_GEOFENCE, "Manual Geofence", 20100),
  selectField(MANUAL_GEOFENCE, "Manual Geofence", 20101, "Operand", [
    { value: "0", label: "No event" },
    { value: "1", label: "On exiting zone" },
    { value: "2", label: "On entering zone" },
    { value: "3", label: "On both" },
  ]),
  eventualRecords(MANUAL_GEOFENCE, "Manual Geofence", 20102),
  numberField(MANUAL_GEOFENCE, "Manual Geofence", 20103, "Border Value", { min: 0, max: 1000000 }),
  selectField(MANUAL_GEOFENCE, "Manual Geofence", 20104, "Shape Type", [
    { value: "0", label: "Circle" },
    { value: "1", label: "Rectangle" },
  ]),
  numberField(MANUAL_GEOFENCE, "Manual Geofence", 20105, "Radius", { min: 0, max: 1000000, unit: "m" }),
  numberField(MANUAL_GEOFENCE, "Manual Geofence", 20106, "Coordinate X1", { min: -180, max: 180, step: 0.000001 }),
  numberField(MANUAL_GEOFENCE, "Manual Geofence", 20107, "Coordinate Y1", { min: -90, max: 90, step: 0.000001 }),
  numberField(MANUAL_GEOFENCE, "Manual Geofence", 20108, "Coordinate X2", { min: -180, max: 180, step: 0.000001 }),
  numberField(MANUAL_GEOFENCE, "Manual Geofence", 20109, "Coordinate Y2", { min: -90, max: 90, step: 0.000001 }),
  selectField(MANUAL_GEOFENCE, "Manual Geofence", 20110, "Overspeeding", ENABLE),
];

const TRIP = "Trip / Odometer";

const tripFields: TeltonikaField[] = [
  scenario(TRIP, "Trip", 11800),
  eventualRecords(TRIP, "Trip", 11801),
  selectField(TRIP, "Trip", 11802, "Mode", [
    { value: "0", label: "Continuous" },
    { value: "1", label: "Between records" },
  ]),
  numberField(TRIP, "Trip", 11803, "Start Speed", { min: 0, max: 255, unit: "km/h", defaultValue: "5" }),
  numberField(TRIP, "Trip", 11804, "Ignition OFF Timeout", { min: 0, max: 65535, unit: "s", defaultValue: "60" }),
  smsTo(TRIP, "Trip", 7031),
  smsText(TRIP, "Trip", 8031),
  selectField(TRIP, "Odometer", 11806, "Calculation Source", [
    { value: "0", label: "GNSS" },
    { value: "1", label: "OBD" },
    { value: "2", label: "LVCAN" },
  ]),
  numberField(TRIP, "Odometer", 11807, "Odometer Value", { min: 0, max: 4294967, unit: "km" }),
];

const BLUETOOTH = "Bluetooth";

const bluetoothFields: TeltonikaField[] = [
  selectField(BLUETOOTH, "Local", 800, "Scenario Settings", [
    { value: "0", label: "Disable" },
    { value: "1", label: "Enable hidden" },
    { value: "2", label: "Enable visible" },
  ]),
  textField(BLUETOOTH, "Local", 801, "Local Name", { placeholder: "FMB1YX_XXXXXXX" }),
  textField(BLUETOOTH, "Local", 802, "Local PIN", { type: "password", sensitive: true }),
  selectField(BLUETOOTH, "Local", 803, "Security Mode", [
    { value: "0", label: "PIN only" },
    { value: "1", label: "PIN and MAC" },
    { value: "2", label: "MAC only" },
    { value: "3", label: "None" },
  ]),
  textField(BLUETOOTH, "External", 804, "External MAC"),
  textField(BLUETOOTH, "External", 805, "External Name"),
  textField(BLUETOOTH, "External", 806, "External PIN", { type: "password", sensitive: true }),
  selectField(BLUETOOTH, "External", 807, "Security Mode", [
    { value: "0", label: "None" },
    { value: "1", label: "Hands free" },
    { value: "2", label: "OBDII" },
    { value: "3", label: "Data link" },
  ]),
  numberField(BLUETOOTH, "Radio", 1110, "BT Power Level", { min: 1, max: 7, defaultValue: "5" }),
  textField(BLUETOOTH, "Radio", 1111, "BLE Broadcasting Service ID"),
];

const BLUETOOTH4 = "Bluetooth 4.0";

const bluetooth4Fields: TeltonikaField[] = [
  selectField(BLUETOOTH4, "Common Settings", 1115, "Non Stop Scan", ENABLE),
  numberField(BLUETOOTH4, "Common Settings", 1100, "TZ-BT04 Update Frequency", { min: 30, max: 65535, unit: "s", defaultValue: "120" }),
  numberField(BLUETOOTH4, "Common Settings", 1113, "BLE Scan Duration", { min: 5, max: 120, unit: "s", defaultValue: "60" }),
  numberField(BLUETOOTH4, "Common Settings", 1114, "Scan Retries Until Error", { min: 0, max: 65535, unit: "s", defaultValue: "30" }),
  selectField(BLUETOOTH4, "Common Settings", 1112, "BLE Connection Control", [
    { value: "0", label: "Prohibit" },
    { value: "1", label: "Allow" },
  ]),
  selectField(BLUETOOTH4, "Connection 1", 1200, "Working Mode", [
    { value: "0", label: "Disabled" },
    { value: "1", label: "TZ-BT04/05/05B sensor" },
    { value: "2", label: "Efento sensor" },
  ]),
  numberField(BLUETOOTH4, "Connection 1", 1201, "TZ Sensor ID", { min: 0, max: 8 }),
  textField(BLUETOOTH4, "Connection 1", 1202, "Efento Sensor MAC"),
];

const BEACON = "Beacon List";

const beaconFields: TeltonikaField[] = [
  selectField(BEACON, "Beacon Detection", 134, "Beacon Detection", [
    { value: "0", label: "Disabled" },
    { value: "1", label: "All" },
    { value: "2", label: "Configured" },
  ]),
  selectField(BEACON, "Beacon Detection", 136, "Beacon Record", [
    { value: "0", label: "Eventual" },
    { value: "1", label: "Periodic" },
  ]),
  numberField(BEACON, "Beacon Detection", 137, "Record Period on Move", { min: 0, max: 259200, unit: "s", defaultValue: "60" }),
  numberField(BEACON, "Beacon Detection", 139, "Record Period on Stop", { min: 0, max: 259200, unit: "s", defaultValue: "60" }),
  textField(BEACON, "Beacon List", 1600, "Beacon 1 ID", {
    placeholder: "UUID:Major:Minor or Namespace:Instance",
    help: "Beacon list entries start at 1600; additional entries use consecutive IDs.",
  }),
];

const AUTH_LIST = "Authorization ID List";

const authorizationFields: TeltonikaField[] = [
  selectField(AUTH_LIST, "Authorization", 11703, "Authorization ID List Checking", AUTH_CHECK),
  textField(AUTH_LIST, "iButton", 30000, "iButton ID 1", {
    placeholder: "64-bit hex ID",
    help: "iButton list spans parameter IDs 30000–33999.",
  }),
  textField(AUTH_LIST, "Authorized Numbers", 4000, "Authorized Number 1", {
    placeholder: "Up to 16 characters",
    help: "Authorized numbers span parameter IDs 4000–4199.",
  }),
];

const IO = "I/O";

const ioFields: TeltonikaField[] = [
  selectField(IO, "Ignition", 50000, "Priority", PRIORITY, { defaultValue: "1" }),
  selectField(IO, "Ignition", 50001, "Operand", [
    { value: "0", label: "On range exit" },
    { value: "1", label: "On range entrance" },
    { value: "2", label: "On both" },
    { value: "3", label: "Monitoring" },
    { value: "4", label: "Hysteresis" },
    { value: "5", label: "On change" },
    { value: "6", label: "On delta change" },
  ], { defaultValue: "5" }),
  numberField(IO, "Ignition", 50002, "High Level", { min: 0, max: 1 }),
  numberField(IO, "Ignition", 50003, "Low Level", { min: 0, max: 1 }),
  selectField(IO, "Ignition", 50004, "Event Only", ENABLE),
  numberField(IO, "Ignition", 50005, "Average", { min: 0, max: 65535, unit: "s", defaultValue: "10" }),
  smsTo(IO, "Ignition", 7000),
  smsText(IO, "Ignition", 8000),
  selectField(IO, "Movement", 50010, "Priority", PRIORITY, { defaultValue: "1" }),
  selectField(IO, "Movement", 50011, "Operand", [
    { value: "0", label: "On range exit" },
    { value: "1", label: "On range entrance" },
    { value: "2", label: "On both" },
    { value: "3", label: "Monitoring" },
    { value: "4", label: "Hysteresis" },
    { value: "5", label: "On change" },
    { value: "6", label: "On delta change" },
  ], { defaultValue: "5" }),
  numberField(IO, "Movement", 50015, "Average", { min: 0, max: 65535, unit: "s", defaultValue: "1" }),
];

const OBD = "OBD II";

const obdFields: TeltonikaField[] = [
  scenario(OBD, "Number of DTC", 40100),
  selectField(OBD, "Number of DTC", 40101, "Operand", [
    { value: "0", label: "On range exit" },
    { value: "1", label: "On range entrance" },
    { value: "2", label: "On both" },
    { value: "3", label: "Monitoring" },
    { value: "4", label: "Hysteresis" },
    { value: "5", label: "On change" },
    { value: "6", label: "On delta change" },
  ], { defaultValue: "3" }),
  numberField(OBD, "Number of DTC", 40102, "High Level", { min: 0, max: 255 }),
  numberField(OBD, "Number of DTC", 40103, "Low Level", { min: 0, max: 255 }),
  selectField(OBD, "Number of DTC", 40104, "Event Only", ENABLE),
  smsTo(OBD, "Number of DTC", 7038),
  smsText(OBD, "Number of DTC", 8038),
];

const CAN = "CAN Adapter";

const canFields: TeltonikaField[] = [
  selectField(CAN, "LVCAN", 45000, "LVCAN Mode", [
    { value: "0", label: "Auto detect" },
    { value: "1", label: "LV-CAN200" },
    { value: "2", label: "ALL-CAN300" },
  ]),
  selectField(CAN, "LVCAN", 45001, "Send Data With 0 If Ignition Is Off", ENABLE),
  numberField(CAN, "LVCAN", 45002, "Program Number", { min: 0, max: 999 }),
  scenario(CAN, "CAN Flag", 45100),
];

const RS232 = "RS232 / RS485";

const rs232Fields: TeltonikaField[] = [
  selectField(RS232, "External UART", 150, "External UART Mode", [
    { value: "0", label: "Disable" },
    { value: "1", label: "RS232" },
    { value: "2", label: "RS485" },
  ]),
  selectField(RS232, "RS232", 151, "Mode", [
    { value: "0", label: "Log Mode" },
    { value: "1", label: "NMEA" },
    { value: "2", label: "LLS" },
    { value: "3", label: "LCD" },
    { value: "4", label: "RFID HID" },
    { value: "5", label: "RFID MF7" },
    { value: "6", label: "Garmin FMI" },
    { value: "7", label: "TCP ASCII" },
    { value: "8", label: "TCP Binary" },
    { value: "11", label: "REC to LCD" },
    { value: "12", label: "ATOL tachograph" },
    { value: "13", label: "UL202-2 Fuel Sensor" },
  ]),
  selectField(RS232, "RS232", 152, "Baudrate", [
    { value: "0", label: "Default" },
    { value: "1", label: "1200" },
    { value: "2", label: "2400" },
    { value: "3", label: "9600" },
    { value: "4", label: "14400" },
    { value: "5", label: "19200" },
    { value: "6", label: "38400" },
    { value: "7", label: "57600" },
    { value: "8", label: "115200" },
  ]),
  selectField(RS232, "RS232", 153, "Parity", [
    { value: "0", label: "Default" },
    { value: "1", label: "None" },
    { value: "2", label: "Odd" },
    { value: "3", label: "Even" },
  ]),
  numberField(RS232, "RS232", 154, "Prefix 1", { min: 0, max: 255 }),
  numberField(RS232, "RS232", 155, "Prefix 2", { min: 0, max: 255 }),
  numberField(RS232, "RS232", 156, "Prefix 3", { min: 0, max: 255 }),
  selectField(RS232, "Garmin", 157, "Garmin Features", [
    { value: "0", label: "No filter" },
    { value: "1", label: "Ping filter" },
    { value: "2", label: "Unicode filter" },
    { value: "3", label: "Ping and Unicode filters" },
  ]),
  selectField(RS232, "RS485", 160, "Mode", [
    { value: "0", label: "Log Mode" },
    { value: "1", label: "NMEA" },
    { value: "2", label: "LLS" },
    { value: "3", label: "TCP ASCII" },
    { value: "4", label: "TCP Binary" },
  ]),
  selectField(RS232, "RS485", 161, "Baudrate", [
    { value: "0", label: "Default" },
    { value: "1", label: "1200" },
    { value: "2", label: "2400" },
    { value: "3", label: "9600" },
    { value: "4", label: "14400" },
    { value: "5", label: "19200" },
    { value: "6", label: "38400" },
    { value: "7", label: "57600" },
    { value: "8", label: "115200" },
  ]),
];

/* -------------------------------------------------------------------------- */
/* Registry assembly                                                           */
/* -------------------------------------------------------------------------- */

export const TELTONIKA_SECTIONS: TeltonikaSection[] = [
  {
    key: "status",
    label: "Status",
    description: "Live device identity, connectivity, firmware, and last record.",
    kind: "status",
    fields: [],
  },
  {
    key: "security",
    label: "Security",
    description: "SMS login, authorized numbers, and call handling.",
    kind: "parameters",
    fields: [
      textField("Security", "SMS Access", 3003, "SMS Login", { sensitive: true, dangerous: true }),
      textField("Security", "SMS Access", 3004, "SMS Password", { type: "password", sensitive: true, dangerous: true }),
      selectField("Security", "Call Handling", 3005, "Incoming Call Action", [
        { value: "0", label: "Do nothing" },
        { value: "1", label: "Hangup" },
        { value: "2", label: "Report position" },
        { value: "4", label: "Auto answer" },
      ]),
      selectField("Security", "Call Handling", 3007, "Outgoing Call Trigger", [
        { value: "0", label: "Disable" },
        { value: "1", label: "DIN1" },
        { value: "2", label: "Crash event" },
        { value: "3", label: "DIN1 and Crash event" },
      ]),
      textField("Security", "Authorized Numbers", 4000, "Authorized Number 1", {
        help: "Authorized numbers span parameter IDs 4000–4199.",
      }),
    ],
  },
  { key: "system", label: "System", description: "Movement, GNSS, sleep, protocol, and ignition source.", kind: "parameters", fields: systemFields },
  { key: "gprs", label: "GPRS", description: "APN, server, backup server, and connection timeouts.", kind: "parameters", fields: gprsFields },
  { key: "data-acquisition", label: "Data Acquisition", description: "Home, roaming, and unknown-network acquisition profiles.", kind: "parameters", fields: dataAcquisitionFields },
  { key: "sms-call", label: "SMS / Call Settings", description: "SMS data sending, call actions, and time zone.", kind: "parameters", fields: smsCallFields },
  { key: "gsm-operators", label: "GSM Operators", description: "Roaming lists, blacklist, and predefined numbers.", kind: "parameters", fields: gsmFields },
  {
    key: "features",
    label: "Features",
    description: "Scenario cards matching the Teltonika Configurator feature grid.",
    kind: "parameters",
    fields: [],
    features: [overspeeding, immobilizer, fuelCounter, jamming, ibutton, doutIgnition],
  },
  {
    key: "accelerometer-features",
    label: "Accelerometer Features",
    description: "Unplug, towing, crash, idling, and motorcycle fall detection.",
    kind: "parameters",
    fields: [],
    features: accelerometerFeatures,
  },
  { key: "auto-geofence", label: "Auto Geofence", description: "Automatic geofence radius, priority, and events.", kind: "parameters", fields: autoGeofenceFields },
  { key: "manual-geofence", label: "Manual Geofence", description: "Circle or rectangle geofence and event behaviour.", kind: "parameters", fields: manualGeofenceFields },
  { key: "trip-odometer", label: "Trip / Odometer", description: "Trip detection, SMS, and odometer source.", kind: "parameters", fields: tripFields },
  { key: "bluetooth", label: "Bluetooth", description: "Local and external Bluetooth radio settings.", kind: "parameters", fields: bluetoothFields },
  { key: "bluetooth-4", label: "Bluetooth 4.0", description: "BLE scan, sensor connections, and broadcasting.", kind: "parameters", fields: bluetooth4Fields },
  { key: "beacon-list", label: "Beacon List", description: "Beacon detection, record periods, and beacon IDs.", kind: "parameters", fields: beaconFields },
  { key: "authorization-id-list", label: "Authorization ID List", description: "iButton and authorized-number access lists.", kind: "parameters", fields: authorizationFields },
  { key: "io", label: "I/O", description: "Digital and analog input event mapping.", kind: "parameters", fields: ioFields },
  { key: "obd-ii", label: "OBD II", description: "OBD II Bluetooth dongle events.", kind: "parameters", fields: obdFields },
  { key: "can-adapter", label: "CAN Adapter", description: "LV-CAN200 / ALL-CAN300 adapter settings.", kind: "parameters", fields: canFields },
  { key: "rs232", label: "RS232 / RS485", description: "External UART, fuel sensor, and tachograph settings.", kind: "parameters", fields: rs232Fields },
];

export const TELTONIKA_FIELDS: TeltonikaField[] = TELTONIKA_SECTIONS.flatMap((section) => [
  ...section.fields,
  ...(section.features ?? []).flatMap((feature) => feature.fields),
]);

export const TELTONIKA_FIELD_BY_ID = new Map(TELTONIKA_FIELDS.map((f) => [f.id, f]));

export const TELTONIKA_FIELD_BY_PARAM = new Map<number, TeltonikaField[]>();
for (const f of TELTONIKA_FIELDS) {
  const rows = TELTONIKA_FIELD_BY_PARAM.get(f.paramId) ?? [];
  rows.push(f);
  TELTONIKA_FIELD_BY_PARAM.set(f.paramId, rows);
}

/**
 * Parameters read by "Load from device". This is the operationally important
 * subset (identity, connectivity, acquisition, feature cards, geofence, trip,
 * UART) rather than every configurable ID, so the tracker is not flooded with
 * 200+ queued reads on a single click.
 */
export const TELTONIKA_LOAD_PARAM_IDS: number[] = [
  138, 133, 106, 107, 108, 109, 113, 102, 103, 1000,
  2000, 2001, 2004, 2005, 2006, 2020, 2025,
  10000, 10004, 10005, 10050, 10055,
  11100, 11104, 11103, 11101, 11102,
  11700, 11701, 11702, 11703, 60068,
  11900, 11901, 11902, 11903, 11904, 11905, 11906, 11907, 11908, 11909,
  11300, 11303, 11304, 11301, 11302, 11305,
  11704, 11705, 11706, 11707,
  12000, 12001, 12002,
  20000, 20002, 20003, 20001, 20005, 20004,
  11800, 11801, 11802, 11803, 11804, 11806, 11807,
  150, 151, 152, 153,
];

export const TELTONIKA_DANGEROUS_PARAMS = new Set(
  TELTONIKA_FIELDS.filter((f) => f.dangerous).map((f) => f.paramId)
);

export function isTeltonikaParam(paramId: number): boolean {
  return TELTONIKA_FIELD_BY_PARAM.has(paramId);
}

export function teltonikaParamLabel(paramId: number): string | null {
  return TELTONIKA_FIELD_BY_PARAM.get(paramId)?.[0]?.label ?? null;
}

export function teltonikaRegistryPayload() {
  return {
    model: "FMB125",
    source: "Teltonika FMB125 Parameter list (03.25.x)",
    sections: TELTONIKA_SECTIONS,
    field_count: TELTONIKA_FIELDS.length,
    load_param_ids: TELTONIKA_LOAD_PARAM_IDS,
    dangerous_param_ids: [...TELTONIKA_DANGEROUS_PARAMS],
  };
}
