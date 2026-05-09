import fleetJson from "@/public/fleet.json";
import type { FleetSeed, FleetSeedShip, LatLng, Port } from "@/lib/domain";

const rawFleet = fleetJson as FleetSeed;

function isLatLng(value: unknown): value is LatLng {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    typeof value[0] === "number" &&
    typeof value[1] === "number"
  );
}

function validatePort(port: Port): void {
  if (!port.id || !port.name || !isLatLng(port.position)) {
    throw new Error(`Invalid port in public/fleet.json: ${JSON.stringify(port)}`);
  }
}

function validateShip(ship: FleetSeedShip): void {
  if (
    !ship.shipId ||
    !ship.name ||
    !isLatLng(ship.position) ||
    typeof ship.speed !== "number" ||
    typeof ship.heading !== "number" ||
    typeof ship.destination !== "string" ||
    typeof ship.fuel !== "number" ||
    typeof ship.cargo !== "string"
  ) {
    throw new Error(`Invalid ship in public/fleet.json: ${JSON.stringify(ship)}`);
  }
}

export function getFleetSeed(): FleetSeed {
  if (rawFleet.fleet.length !== 15) {
    throw new Error(`public/fleet.json must contain exactly 15 ships, found ${rawFleet.fleet.length}.`);
  }

  rawFleet.ports.forEach(validatePort);
  rawFleet.fleet.forEach(validateShip);

  if (rawFleet.navigableWater.length < 4 || !rawFleet.navigableWater.every(isLatLng)) {
    throw new Error("public/fleet.json must contain a closed navigable-water polygon.");
  }

  return rawFleet;
}
