export {
  buildDestinations,
  buildMatrix,
  buildSources,
  readRoute,
  readRoutes,
} from './model.js';
export { isLegal, legalSources } from './validity.js';
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
