/**
 * match_product_by_image — AI tool (Phase 2 image matching).
 *
 * Same ToolFn shape as the tools in tools.ts. Note: tools.ts does not export
 * its ToolFn type, so the identical signature is declared locally here.
 * The coordinator registers this as the `match_product_by_image` tool.
 *
 * Args: { imageRef | imageUrl | url, limit? }
 * Result: matchProductsByImage() — { available, matches, uncertain, message? }.
 * When no embedding provider is configured, available=false and the agent
 * must tell the customer (in Bengali) that image search is not on yet.
 * Matches come only from product_images/products — never invented.
 */
import type { ToolDb, ToolArgs, ToolResult } from './tools';
import { matchProductsByImage } from './image-match';

type ToolFn = (db: ToolDb, workspaceId: string, args: ToolArgs) => Promise<ToolResult>;

function asString(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

export const matchProductByImage: ToolFn = async (_db, workspaceId, args) => {
  const imageRef = asString(args.imageRef ?? args.imageUrl ?? args.url);
  if (!imageRef) return { error: 'match_product_by_image needs imageRef' };
  const limitRaw = Number(args.limit ?? 3);
  const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(5, Math.floor(limitRaw))) : 3;
  const result = await matchProductsByImage(workspaceId, imageRef, limit);
  return result as unknown as ToolResult;
};
