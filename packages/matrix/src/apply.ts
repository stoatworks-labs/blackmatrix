import type { Destination } from './types.js';

/**
 * The slice of `atem-connection`'s Atem class this package needs. Declaring it
 * structurally means a mock switcher satisfies it without pretending to be one.
 */
export interface AtemRouterCommands {
  setAuxSource(source: number, bus?: number): Promise<void>;
  changeProgramInput(input: number, me?: number): Promise<void>;
  changePreviewInput(input: number, me?: number): Promise<void>;
  setUpstreamKeyerFillSource(fillSource: number, me?: number, keyer?: number): Promise<void>;
  setUpstreamKeyerCutSource(cutSource: number, me?: number, keyer?: number): Promise<void>;
  setDownstreamKeyFillSource(input: number, key?: number): Promise<void>;
  setDownstreamKeyCutSource(input: number, key?: number): Promise<void>;
  setSuperSourceBoxSettings(props: { source: number }, box?: number, ssrcId?: number): Promise<void>;
  setSuperSourceProperties(
    props: { artFillSource?: number; artCutSource?: number },
    ssrcId?: number,
  ): Promise<void>;
  setMultiViewerWindowSource(source: number, mv?: number, window?: number): Promise<void>;
}

/** Send one crosspoint to the switcher. */
export async function applyRoute(
  atem: AtemRouterCommands,
  destination: Destination,
  source: number,
): Promise<void> {
  const { unit, slot } = destination.address;
  switch (destination.kind) {
    case 'aux':
      return atem.setAuxSource(source, unit);
    case 'program':
      return atem.changeProgramInput(source, unit);
    case 'preview':
      return atem.changePreviewInput(source, unit);
    case 'uskFill':
      return atem.setUpstreamKeyerFillSource(source, unit, slot ?? 0);
    case 'uskKey':
      return atem.setUpstreamKeyerCutSource(source, unit, slot ?? 0);
    case 'dskFill':
      return atem.setDownstreamKeyFillSource(source, unit);
    case 'dskKey':
      return atem.setDownstreamKeyCutSource(source, unit);
    case 'ssrcBox':
      return atem.setSuperSourceBoxSettings({ source }, slot ?? 0, unit);
    case 'ssrcArtFill':
      return atem.setSuperSourceProperties({ artFillSource: source }, unit);
    case 'ssrcArtKey':
      return atem.setSuperSourceProperties({ artCutSource: source }, unit);
    case 'mvWindow':
      return atem.setMultiViewerWindowSource(source, unit, slot ?? 0);
    default:
      throw new Error(`unroutable destination: ${destination.id}`);
  }
}
