/* eslint-disable no-console */
import 'reflect-metadata';
import * as dotenv from 'dotenv';
import express, { Application, Request, Response } from 'express';
import morgan from 'morgan';
import helmet from 'helmet';
import bodyParser from 'body-parser';
import swaggerUi from 'swagger-ui-express';
import colors from 'colors';
import { swaggerConf, swaggerSpec } from './middlewares/swagger';
import expressErrorHandler from './middlewares/errorHandler';
import corsConf from './middlewares/cors';
import routes from './routes';
import seedAdminUser from './seed';
import AppDataSource from './data-source';
import { ensureDevicePaired, gateway } from './services/openclawGateway';
import attachPtyWebSocket from './services/ptyService';
import { startUpdateChecker } from './services/updateService';

dotenv.config();

const app: Application = express();
app.use('/api/public', express.static(`${__dirname}/public`));
app.use(helmet());
app.use(corsConf);
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());
if (['test', 'development'].includes(process.env.NODE_ENV)) app.use(morgan('dev'));
if (process.env.NODE_ENV === 'development') app.use('/api/docs', swaggerUi.serve, swaggerConf);
app.use('/api', routes);
app.use((_req: Request, res: Response) => res.status(404).json({ message: 'Not found' }));
app.use(expressErrorHandler);

const PORT = Number(process.env.PORT) || 18802;

(async () => {
  try {
    if (process.env.NODE_ENV === 'test') return;

    await AppDataSource.initialize();
    console.log(colors.green('SQLite database connected'));
    await seedAdminUser();
    await ensureDevicePaired();
    const gwOk = await gateway.ensureConnected();
    console.log(
      gwOk
        ? colors.green('[gateway] persistent connection ready')
        : colors.yellow('[gateway] initial connection failed, will use CLI fallback')
    );

    const API_HOST = process.env.API_HOST || '0.0.0.0';
    const server = app.listen(PORT, API_HOST, () => console.log(colors.green(`running on ${API_HOST}:${PORT}`)));
    attachPtyWebSocket(server);
    startUpdateChecker();
  } catch (error) {
    console.log(colors.red('%s'), error);
  }
})();

export { app, swaggerSpec };
