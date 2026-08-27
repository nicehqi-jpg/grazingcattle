/**
 * POST /api/farms/[farmId]/move-cow — move a single cow to a different paddock.
 *
 * HOW THIS WORKS:
 * The browser sends { cowId, targetPaddockId }. This handler:
 *   1. Loads the farm from the DB (server is authoritative — client only sends ids).
 *   2. Validates the cow exists, is alive, and the target paddock exists.
 *   3. Updates currentPaddockId on that one cow.
 *   4. Saves and returns the updated farm.
 *
 * WHY THIS EXISTS SEPARATELY FROM move-herd:
 * move-herd moves the entire live herd as a management action (rotation).
 * move-cow is a precision action: rescue a thin cow by giving her sole access
 * to a resting paddock, or rotate a bull into a mob deliberately. These are
 * distinct farming decisions with different intents.
 *
 * BREEDING IMPLICATION:
 * After this call, the simulation will only allow conception between females
 * and males that share the same currentPaddockId. Moving a bull away from a
 * mob stops breeding in that mob immediately on the next tick.
 */

import { createClient } from "@/lib/supabase/server";
import { createDb, listRecentFarmEvents, loadFarm, saveFarm } from "@grazingcattle/db";
import { NextResponse } from "next/server";
import { z } from "zod";

export const runtime = "nodejs";

const bodySchema = z.object({
  cowId:           z.string().min(1),
  targetPaddockId: z.string().min(1),
});

export const POST = async (
  request: Request,
  { params }: { params: Promise<{ farmId: string }> },
) => {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { farmId } = await params;

  const parsed = bodySchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const { cowId, targetPaddockId } = parsed.data;

  const db = createDb();
  const state = await loadFarm(db, farmId);
  if (!state) return NextResponse.json({ error: "Farm not found" }, { status: 404 });

  const cow = state.cows.find((c) => c.id === cowId);
  if (!cow) return NextResponse.json({ error: "Cow not found" }, { status: 404 });
  if (cow.status === "dead" || cow.status === "sold" || cow.status === "slaughtered") {
    return NextResponse.json({ error: "Cow is not alive" }, { status: 400 });
  }

  const paddock = state.paddocks.find((p) => p.id === targetPaddockId);
  if (!paddock) return NextResponse.json({ error: "Paddock not found" }, { status: 404 });

  const updatedCows = state.cows.map((c) =>
    c.id === cowId ? { ...c, currentPaddockId: targetPaddockId } : c,
  );
  const updatedFarm = { ...state, cows: updatedCows };

  await saveFarm(db, updatedFarm, [], new Date());
  const recentEvents = await listRecentFarmEvents(db, farmId, 50);

  return NextResponse.json({ farm: updatedFarm, events: recentEvents });
};
