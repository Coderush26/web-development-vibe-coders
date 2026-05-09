export type LatLng = [number, number];

export type ShipStatus =
  | "normal"
  | "rerouting"
  | "distressed"
  | "stopped"
  | "insufficient_fuel"
  | "stranded"
  | "out_of_fuel"
  | "arrived";

export type AlertType =
  | "restricted_zone_breach"
  | "proximity_warning"
  | "distress_escalation"
  | "stranded"
  | "insufficient_fuel"
  | "out_of_fuel"
  | "arrival";

export type AlertSeverity = "info" | "warning" | "critical";

export type DirectiveType = "HOLD_POSITION" | "RESUME_COURSE" | "CHANGE_SPEED" | "REROUTE_PORT";

export type DirectiveStatus = "pending" | "accepted" | "distress_escalated";

export type CaptainResponseType = "ACCEPT" | "ESCALATE_DISTRESS";

export type WeatherSample = {
  id: string;
  position: LatLng;
  timestamp: number;
  adverse: boolean;
  summary: string;
  fuelMultiplier: number;
};

export type Port = {
  id: string;
  name: string;
  position: LatLng;
};

export type BoundingBox = {
  north: number;
  south: number;
  east: number;
  west: number;
};

export type FleetSeedShip = {
  shipId: string;
  name: string;
  position: LatLng;
  speed: number;
  heading: number;
  destination: string;
  fuel: number;
  cargo: string;
  status: ShipStatus;
};

export type FleetSeed = {
  scenario: {
    name: string;
    description: string;
  };
  coordinateFormat: string;
  units: {
    speed: string;
    fuel: string;
    heading: string;
  };
  boundingBox: BoundingBox;
  navigableWater: LatLng[];
  ports: Port[];
  fleet: FleetSeedShip[];
};

export type RoutePlan = {
  shipId: string;
  waypoints: LatLng[];
  distanceKm: number;
  estimatedFuelTons: number;
  weatherExposure: "clear" | "adverse";
  valid: boolean;
  reason?: string;
};

export type ShipState = {
  id: string;
  name: string;
  position: LatLng;
  previousPosition: LatLng;
  speedKnots: number;
  cruisingSpeedKnots: number;
  headingDegrees: number;
  destinationPortId: string;
  fuelTons: number;
  cargo: string;
  status: ShipStatus;
  currentRoute: RoutePlan;
  activeWaypointIndex: number;
  lastUpdateAt: number;
  weatherMultiplier: number;
};

export type RestrictedZone = {
  id: string;
  name: string;
  polygon: LatLng[];
  createdBy: "command";
  createdAt: number;
  updatedAt: number;
  active: boolean;
  editable: boolean;
};

export type Alert = {
  id: string;
  type: AlertType;
  severity: AlertSeverity;
  affectedShipIds: string[];
  message: string;
  createdAt: number;
  acknowledgedAt?: number;
  resolvedAt?: number;
  sourceEventId: string;
};

export type DistressAnalysis = {
  severity: AlertSeverity;
  problemCategory: string;
  impacts: Record<string, number | string>;
  confidence: number;
  source: "local_rules";
};

export type Directive = {
  id: string;
  targetShipId: string;
  type: DirectiveType;
  payload: Record<string, string | number | boolean>;
  issuedBy: "command";
  issuedAt: number;
  status: DirectiveStatus;
  captainResponse?: CaptainResponse;
};

export type CaptainResponse = {
  directiveId: string;
  shipId: string;
  responseType: CaptainResponseType;
  distressMessage?: string;
  distressAnalysis?: DistressAnalysis;
  respondedAt: number;
};

export type HistorySnapshot = {
  timestamp: number;
  shipPositions: Array<{
    shipId: string;
    position: LatLng;
    status: ShipStatus;
    fuelTons: number;
  }>;
  keyEvents: string[];
  activeAlertCount: number;
  restrictedZoneCount: number;
};

export type SimulatorSnapshot = {
  scenarioName: string;
  serverTime: number;
  tick: number;
  stateVersion: number;
  boundingBox: BoundingBox;
  navigableWater: LatLng[];
  ports: Port[];
  ships: ShipState[];
  restrictedZones: RestrictedZone[];
  alerts: Alert[];
  directives: Directive[];
  weatherSamples: WeatherSample[];
  history: HistorySnapshot[];
  metrics: {
    connectedViewers: number;
    tickHz: number;
    activeShips: number;
  };
};

export type SimulatorStreamEvent = {
  eventId: string;
  sentAt: number;
  transport: "sse";
  snapshot: SimulatorSnapshot;
};

export type SimulatorCommand =
  | {
      type: "issue_directive";
      targetShipId: string;
      directiveType: DirectiveType;
      payload: Record<string, string | number | boolean>;
    }
  | {
      type: "captain_response";
      directiveId: string;
      responseType: CaptainResponseType;
      distressMessage?: string;
    }
  | {
      type: "create_zone";
      name: string;
      polygon: LatLng[];
    }
  | {
      type: "set_zone_active";
      zoneId: string;
      active: boolean;
    }
  | {
      type: "ack_alert";
      alertId: string;
    }
  | {
      type: "update_weather";
      samples: WeatherSample[];
    };
