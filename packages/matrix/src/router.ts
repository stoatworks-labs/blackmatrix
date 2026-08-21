import type { Destination, MatrixModel, Section, Source } from './types.js';

/**
 * A plain router's matrix: any input on any output.
 *
 * Shared by the Videohub device and the simulator so there is one definition of
 * what a router looks like in this app. Nothing here knows about switchers —
 * `accepts: 'any'` is the whole rule, because a router has no availability
 * masks and pretending otherwise would hatch out the grid.
 */
export interface RouterMatrixInput {
  inputLabels: string[];
  outputLabels: string[];
  monitoringLabels?: string[];
  /** Input index per output, -1 where unknown. */
  routing: number[];
  monitoringRouting?: number[];
}

const SECTIONS: Section[] = [
  { id: 'outputs', label: 'Outputs', hint: 'Router video outputs' },
  { id: 'monitoring', label: 'Monitoring outputs', hint: 'The router’s monitoring outputs' },
];

function shorten(label: string): string {
  return label.length <= 8 ? label : label.slice(0, 8);
}

export function buildRouterMatrix(input: RouterMatrixInput): MatrixModel {
  const sources: Source[] = input.inputLabels.map((label, index) => ({
    id: index,
    label: label || `Input ${index + 1}`,
    short: shorten(label || `In ${index + 1}`),
    kind: 'router',
    // Present so the shape matches a switcher's; `accepts: 'any'` is what decides.
    availability: 0xff,
    meAvailability: 0xff,
  }));

  const destinations: Destination[] = [];
  input.outputLabels.forEach((label, index) => {
    destinations.push({
      id: `out.${index}`,
      kind: 'routerOutput',
      section: 'outputs',
      label: label || `Output ${index + 1}`,
      short: shorten(label || `Out ${index + 1}`),
      address: { unit: index },
      accepts: 'any',
    });
  });
  (input.monitoringLabels ?? []).forEach((label, index) => {
    destinations.push({
      id: `mon.${index}`,
      kind: 'routerMonitoring',
      section: 'monitoring',
      label: label || `Monitor ${index + 1}`,
      short: shorten(label || `Mon ${index + 1}`),
      address: { unit: index },
      accepts: 'any',
    });
  });

  const routes: Record<string, number> = {};
  for (const destination of destinations) {
    const table = destination.kind === 'routerMonitoring' ? (input.monitoringRouting ?? []) : input.routing;
    routes[destination.id] = table[destination.address.unit] ?? -1;
  }

  return {
    sections: SECTIONS.filter((section) =>
      destinations.some((destination) => destination.section === section.id),
    ),
    sources,
    destinations,
    routes,
  };
}
