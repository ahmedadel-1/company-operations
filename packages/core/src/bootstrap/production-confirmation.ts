export class ProductionConfirmationError extends Error {
  constructor() {
    super('In production, pass --confirm-production with the same slug to confirm.');
    this.name = 'ProductionConfirmationError';
  }
}

/** In production the bootstrap CLI runs only when the operator repeats the target slug (ROADMAP P1-5). */
export function assertProductionConfirmed(nodeEnv: string, slug: string, confirmation: string | undefined): void {
  if (nodeEnv === 'production' && confirmation !== slug) {
    throw new ProductionConfirmationError();
  }
}
