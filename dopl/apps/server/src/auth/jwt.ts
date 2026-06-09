// JWT 발급/검증. REST와 Socket.IO 연결이 동일 토큰을 쓴다.
import jwt from 'jsonwebtoken';

const SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const EXPIRES_IN = '7d';

export interface JwtPayload {
  uid: number;
  username: string;
}

export function signToken(payload: JwtPayload): string {
  return jwt.sign(payload, SECRET, { expiresIn: EXPIRES_IN });
}

export function verifyToken(token: string): JwtPayload {
  return jwt.verify(token, SECRET) as JwtPayload;
}
