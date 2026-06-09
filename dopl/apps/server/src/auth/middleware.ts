import type { Request, Response, NextFunction } from 'express';
import { verifyToken, type JwtPayload } from './jwt.js';

export interface AuthedRequest extends Request {
  user?: JwtPayload;
}

// Authorization: Bearer <token> 검증. 통과 시 req.user 주입.
export function requireAuth(req: AuthedRequest, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    res.status(401).json({ error: '인증이 필요합니다.' });
    return;
  }
  try {
    req.user = verifyToken(header.slice(7));
    next();
  } catch {
    res.status(401).json({ error: '토큰이 유효하지 않습니다.' });
  }
}
