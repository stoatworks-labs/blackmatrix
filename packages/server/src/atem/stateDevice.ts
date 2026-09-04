import { EventEmitter } from 'node:events';
import { AtemStateUtil, type AtemState } from 'atem-connection';
import type { AtemRouterCommands } from '@av/atem-matrix';
import type { ConnectionState, DeviceRunner } from './device.js';

/**
 * A switcher that is an AtemState and nothing else: it honours every routing
 * command the real one does by mutating that state and announcing the change.
 *
 * Two things are built on it. The mock fleet, whose state is synthesised, and
 * replay, whose state was captured off real hardware — so a capture taken while
 * a switcher was on the bench keeps exercising this code long after the
 * switcher has gone back in its case.
 */
export class StateDevice extends EventEmitter implements DeviceRunner, AtemRouterCommands {
  readonly id: string;
  readonly name: string;
  readonly address: string;
  protected atemState: AtemState;
  private product: string;
  private status: ConnectionState = 'disconnected';

  constructor(options: { id: string; name: string; address: string; model: string; state: AtemState }) {
    super();
    this.id = options.id;
    this.name = options.name;
    this.address = options.address;
    this.product = options.model;
    this.atemState = options.state;
  }

  get connection(): ConnectionState {
    return this.status;
  }

  get state(): AtemState | null {
    return this.status === 'connected' ? this.atemState : null;
  }

  get model(): string {
    return this.atemState.info.productIdentifier ?? this.product;
  }

  /**
   * Null, always. This device simulates the crosspoints and nothing else, and
   * a simulated switcher that accepted `startRecording` and did nothing would
   * be worse than one that says it cannot.
   */
  get full(): null {
    return null;
  }

  get commands(): AtemRouterCommands | null {
    return this.status === 'connected' ? this : null;
  }

  async connect(): Promise<void> {
    this.status = 'connected';
    this.emit('connection', this.status);
    this.emit('state');
  }

  async disconnect(): Promise<void> {
    this.status = 'disconnected';
    this.emit('connection', this.status);
  }

  protected changed(): void {
    this.emit('state');
  }

  async setInputLabel(inputId: number, longName: string, shortName: string): Promise<void> {
    const input = this.atemState.inputs[inputId];
    if (!input) return;
    input.longName = longName;
    input.shortName = shortName;
    this.changed();
  }

  /**
   * Honours only what the switcher said it would: assigning an input to a plug
   * it does not list is what the real one refuses, so the simulation refuses it
   * too rather than showing a state no hardware would produce.
   */
  async setInputPort(inputId: number, externalPortType: number): Promise<void> {
    const input = this.atemState.inputs[inputId];
    if (!input) return;
    if (!(input.externalPorts ?? []).includes(externalPortType)) return;
    input.externalPortType = externalPortType;
    this.changed();
  }

  async setAuxSource(source: number, bus = 0): Promise<void> {
    this.atemState.video.auxilliaries[bus] = source;
    this.changed();
  }

  async changeProgramInput(input: number, me = 0): Promise<void> {
    AtemStateUtil.getMixEffect(this.atemState, me).programInput = input;
    this.changed();
  }

  async changePreviewInput(input: number, me = 0): Promise<void> {
    AtemStateUtil.getMixEffect(this.atemState, me).previewInput = input;
    this.changed();
  }

  async setUpstreamKeyerFillSource(fillSource: number, me = 0, keyer = 0): Promise<void> {
    const upstreamKeyer = AtemStateUtil.getMixEffect(this.atemState, me).upstreamKeyers[keyer];
    if (upstreamKeyer) upstreamKeyer.fillSource = fillSource;
    this.changed();
  }

  async setUpstreamKeyerCutSource(cutSource: number, me = 0, keyer = 0): Promise<void> {
    const upstreamKeyer = AtemStateUtil.getMixEffect(this.atemState, me).upstreamKeyers[keyer];
    if (upstreamKeyer) upstreamKeyer.cutSource = cutSource;
    this.changed();
  }

  async setDownstreamKeyFillSource(input: number, key = 0): Promise<void> {
    const downstreamKeyer = this.atemState.video.downstreamKeyers[key];
    if (downstreamKeyer?.sources) downstreamKeyer.sources.fillSource = input;
    this.changed();
  }

  async setDownstreamKeyCutSource(input: number, key = 0): Promise<void> {
    const downstreamKeyer = this.atemState.video.downstreamKeyers[key];
    if (downstreamKeyer?.sources) downstreamKeyer.sources.cutSource = input;
    this.changed();
  }

  async setSuperSourceBoxSettings(props: { source: number }, box = 0, ssrcId = 0): Promise<void> {
    const superSourceBox = AtemStateUtil.getSuperSource(this.atemState, ssrcId).boxes[box as 0 | 1 | 2 | 3];
    if (superSourceBox) superSourceBox.source = props.source;
    this.changed();
  }

  async setSuperSourceProperties(
    props: { artFillSource?: number; artCutSource?: number },
    ssrcId = 0,
  ): Promise<void> {
    const properties = AtemStateUtil.getSuperSource(this.atemState, ssrcId).properties;
    if (properties) {
      if (props.artFillSource !== undefined) properties.artFillSource = props.artFillSource;
      if (props.artCutSource !== undefined) properties.artCutSource = props.artCutSource;
    }
    this.changed();
  }

  async setMultiViewerWindowSource(source: number, mv = 0, window = 0): Promise<void> {
    const multiViewerWindow = AtemStateUtil.getMultiViewer(this.atemState, mv).windows[window];
    if (multiViewerWindow) multiViewerWindow.source = source;
    this.changed();
  }
}
