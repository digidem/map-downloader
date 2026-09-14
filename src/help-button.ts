import { html, nothing, type TemplateResult } from "lit";
import { classMap } from "lit/directives/class-map.js";
import { LightElement } from "./lit-base.ts";

export interface HelpButtonOptions {
  /** Fired when the popover opens — lets the host close sibling popovers. */
  onOpen?: () => void;
}

export class HelpButton extends LightElement {
  static properties = {
    open: { state: true },
  };

  declare open: boolean;

  private opts: HelpButtonOptions = {};

  constructor() {
    super();
    this.open = false;
  }

  /** Inject runtime options. Custom-element constructors take no arguments. */
  init(opts: HelpButtonOptions = {}): this {
    this.opts = opts;
    return this;
  }

  get el(): this {
    return this;
  }

  connectedCallback() {
    super.connectedCallback();
    this.classList.add("help-root");
  }

  close() {
    this.open = false;
  }

  private toggle() {
    if (this.open) {
      this.open = false;
    } else {
      this.opts.onOpen?.();
      this.open = true;
    }
  }

  render() {
    return html`
      <button
        class=${classMap({ "help-btn": true, "help-btn-active": this.open })}
        aria-label="Help"
        @click=${() => this.toggle()}
      >
        <!-- Material Symbols "help" (filled). viewBox is Material's 960-grid. -->
        <svg width="18" height="18" viewBox="0 -960 960 960" fill="currentColor">
          <path d="M513.5-254.5Q528-269 528-290t-14.5-35.5Q499-340 478-340t-35.5 14.5Q428-311 428-290t14.5 35.5Q457-240 478-240t35.5-14.5ZM442-394h74q0-33 7.5-52t42.5-52q26-26 41-49.5t15-56.5q0-56-41-86t-97-30q-57 0-92.5 30T342-618l66 26q5-18 22.5-39t53.5-21q32 0 48 17.5t16 38.5q0 20-12 37.5T506-526q-44 39-54 59t-10 73Zm38 314q-83 0-156-31.5T197-197q-54-54-85.5-127T80-480q0-83 31.5-156T197-763q54-54 127-85.5T480-880q83 0 156 31.5T763-763q54 54 85.5 127T880-480q0 83-31.5 156T763-197q-54 54-127 85.5T480-80Z" />
        </svg>
      </button>
      ${this.open ? this.renderPopover() : nothing}
    `;
  }

  private renderPopover(): TemplateResult {
    return html`
      <div class="help-popover-wrap" @click=${() => this.close()}>
        <div class="help-popover" @click=${(e: Event) => e.stopPropagation()}>
          <div class="help-popover-header">
            <div class="help-popover-title">About this tool</div>
            <button
              class="help-popover-close"
              aria-label="Close"
              @click=${() => this.close()}
            >×</button>
          </div>
          <p>
            Pick a region of the world and download its map tiles for
            <b>offline use</b> — useful for fieldwork, hiking, or low-bandwidth
            environments.
          </p>
          <div class="help-stepper">
            <div class="help-step">
              <div class="help-step-num">1</div>
              <div class="help-step-text">
                Pan and zoom the map to the area you want.
              </div>
            </div>
            <div class="help-step">
              <div class="help-step-num">2</div>
              <div class="help-step-text">
                Drag the bbox handles to fine-tune the region, or type bounds
                directly.
              </div>
            </div>
            <div class="help-step">
              <div class="help-step-num">3</div>
              <div class="help-step-text">
                Click <b>Download</b> to choose a max zoom and save the
                package.
              </div>
            </div>
          </div>
          <div class="help-popover-tip">
            Tip: smaller area + lower max zoom = smaller download.
          </div>
        </div>
      </div>
    `;
  }
}

if (!customElements.get("help-button")) {
  customElements.define("help-button", HelpButton);
}
