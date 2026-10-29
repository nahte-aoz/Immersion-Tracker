declare global {
  namespace Express {
    interface Request {
      requestTime?: number;
    }
  }
}

export {};