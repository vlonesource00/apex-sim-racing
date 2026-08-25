const CLASS_GRID_PRIORITY = Object.freeze({ prototype: 0, gt: 1, touring: 2 });

export function orderVehiclesByClassPace(vehicles) {
  const originalIndex = new Map(vehicles.map((vehicle, index) => [vehicle.id, index]));
  return [...vehicles].sort((a, b) => {
    const classDelta = (CLASS_GRID_PRIORITY[a.classKey] ?? 99)
      - (CLASS_GRID_PRIORITY[b.classKey] ?? 99);
    return classDelta || originalIndex.get(a.id) - originalIndex.get(b.id);
  });
}

export { CLASS_GRID_PRIORITY };
