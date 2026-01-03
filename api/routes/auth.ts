import { Router, type Request, type Response } from 'express'

const router = Router()

router.post('/register', async (req: Request, res: Response): Promise<void> => {})

router.post('/login', async (req: Request, res: Response): Promise<void> => {})

router.post('/logout', async (req: Request, res: Response): Promise<void> => {})

export default router
