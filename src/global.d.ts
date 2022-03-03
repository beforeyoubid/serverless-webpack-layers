interface CustomGlobal extends NodeJS.Global {
  PACKAGING_LABELS: boolean;
}

declare const global: CustomGlobal;
