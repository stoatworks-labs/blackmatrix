export {
  buildDestinations,
  buildMatrix,
  buildSources,
  readRoute,
  readRoutes,
} from './model.js';
export { isLegal, legalSources } from './validity.js';
export { buildRouterMatrix, type RouterMatrixInput } from './router.js';
export { buildSimulatedState, type SwitcherProfile } from './simulate.js';
export { applyRouteToState } from './mutate.js';
export { ExternalPortType, InternalPortType, MeAvailability, SourceAvailability } from './enums.js';
export { applyRoute, type AtemRouterCommands } from './apply.js';
export {
  ATEM_SECTIONS,
  PORT_LABELS,
  portLabel,
  type Acceptance,
  type Destination,
  type DestinationAddress,
  type DestinationKind,
  type MatrixModel,
  type Section,
  type SectionId,
  type Source,
  type SourceKind,
  type SourcePorts,
} from './types.js';
