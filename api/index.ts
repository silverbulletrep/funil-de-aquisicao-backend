/**
 * Vercel deploy entry handler, for serverless deployment, please don't modify this file
 */
import app from './app.js'

export default function handler(...args: unknown[]) {
  return (app as unknown as (...args: unknown[]) => unknown)(...args)
}
