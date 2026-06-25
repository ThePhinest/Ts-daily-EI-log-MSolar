export interface PresentOptions {
  /** Remote (tokenized) URL — downloaded natively to a temp file before display. */
  url?: string;
  /** Local file path/URL for an offline-pinned doc — displayed directly. */
  path?: string;
  /** Title shown in the viewer nav bar. */
  title?: string;
  /** Zero-based page to open on. */
  startPage?: number;
}

export interface PresentResult {
  closed: boolean;
  /** Zero-based index of the page the user was on at close. */
  lastPage: number;
}

export interface GroundLogPdfPlugin {
  present(options: PresentOptions): Promise<PresentResult>;
}

export declare const GroundLogPdf: GroundLogPdfPlugin;
