export interface AuthUser {
  id: string;
  name: string;
}

declare module 'express-serve-static-core' {
  interface Request {
    user?: AuthUser;
  }
}
