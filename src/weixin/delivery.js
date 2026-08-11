// Re-exports telegram delivery primitives for weixin.
// Both channels use the same outbox mechanism.
export { TelegramDeliveryWorker, runTelegramDeliveryLoop } from '../telegram/delivery.js';
