import express, { type Express, type Request, type Response, type NextFunction } from 'express';

const app: Express = express();
const port = 3000;

const requestTime = function (req: Request, res: Response, next: NextFunction) {
  req.requestTime = Date.now();
  next();
};

app.use(requestTime);

app.get('/', (req: Request, res: Response) => {
  let responseText = 'Hello World!<br>';
  responseText += `<small>Requested at: ${req.requestTime}</small>`;
  res.send(responseText);
});

app.put('/secret/a', (req: Request, res: Response) => {
    res.send("Successfully accessed the secret server mwuahaha!");
})

app.listen(port, () => {
  console.log(`Example app listening on port ${port}`);
});