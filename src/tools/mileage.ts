import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createExpense, handleFAError } from "../services/freeagent.js";
import {
  calculateDistance,
  isDistanceConfigured,
} from "../services/distance.js";
import {
  HMRC_RATE_HIGH_PENCE,
  HMRC_RATE_LOW_PENCE,
  HMRC_THRESHOLD_MILES,
} from "../constants.js";

function getMileageCategoryUrl(): string {
  return process.env.MILEAGE_CATEGORY_URL ?? "/v2/categories/311";
}

function getDefaultRate(): number | null {
  const env = process.env.MILEAGE_RATE_PENCE;
  if (env) {
    const rate = parseFloat(env);
    if (!isNaN(rate) && rate > 0) return rate;
  }
  return null;
}

export function registerMileageTools(server: McpServer): void {
  server.registerTool(
    "freeagent_create_mileage_expense",
    {
      description:
        "Create a mileage expense in FreeAgent. " +
        "Provide either origin + destination (requires ORS_API_KEY or GOOGLE_MAPS_API_KEY for distance lookup) " +
        "or manualMiles for the journey distance. Set roundTrip=true to double the distance.\n\n" +
        "Rate: pass ratePence to set the per-mile rate explicitly (e.g. 45 for 45p/mile). " +
        "If omitted, defaults to the MILEAGE_RATE_PENCE env var, or HMRC approved rates " +
        "(45p first 10,000 miles, 25p thereafter — pass cumulativeMilesYTD to enable threshold logic).",
      inputSchema: z
        .object({
          datedOn: z
            .string()
            .regex(/^\d{4}-\d{2}-\d{2}$/)
            .describe("Journey date YYYY-MM-DD"),
          description: z
            .string()
            .min(1)
            .describe("Journey description (e.g. 'Office to client site, quarterly review')"),
          origin: z
            .string()
            .optional()
            .describe("Origin address. Requires distance API key. Omit if providing manualMiles."),
          destination: z
            .string()
            .optional()
            .describe("Destination address. Requires distance API key. Omit if providing manualMiles."),
          manualMiles: z
            .number()
            .positive()
            .optional()
            .describe("Journey distance in miles (use instead of origin/destination)"),
          roundTrip: z
            .boolean()
            .default(false)
            .describe("Double the distance for a return journey"),
          ratePence: z
            .number()
            .positive()
            .optional()
            .describe(
              "Pence per mile (e.g. 45). If omitted, uses MILEAGE_RATE_PENCE env var " +
              "or HMRC rates (45p/25p with threshold logic if cumulativeMilesYTD provided)."
            ),
          cumulativeMilesYTD: z
            .number()
            .min(0)
            .optional()
            .describe(
              "Cumulative business miles already claimed this tax year. " +
              "Used for HMRC threshold logic (45p→25p at 10,000 miles). " +
              "Only relevant when ratePence is not set."
            ),
          currency: z
            .string()
            .length(3)
            .default("GBP")
            .describe("ISO 4217 currency code (default GBP)"),
        })
        .strict(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
      },
    },
    async (args) => {
      try {
        // ── Resolve distance ──────────────────────────────────────────────
        let miles: number;
        let journeyDetail: string;

        if (args.manualMiles) {
          miles = args.manualMiles;
          journeyDetail = `${miles} miles (manual)`;
        } else if (args.origin && args.destination) {
          if (!isDistanceConfigured()) {
            return {
              content: [
                {
                  type: "text",
                  text: "Error: No distance API configured. Set ORS_API_KEY or GOOGLE_MAPS_API_KEY, or provide manualMiles.",
                },
              ],
              isError: true,
            };
          }
          const result = await calculateDistance(args.origin, args.destination);
          miles = result.distanceMiles;
          journeyDetail = `${args.origin} to ${args.destination} = ${miles} miles (${result.provider})`;
        } else {
          return {
            content: [
              {
                type: "text",
                text: "Error: Provide either manualMiles or both origin and destination.",
              },
            ],
            isError: true,
          };
        }

        if (args.roundTrip) {
          miles = miles * 2;
          journeyDetail += " (round trip)";
        }

        // ── Calculate rate and amount ─────────────────────────────────────
        let ratePence: number;
        let breakdown: string;

        if (args.ratePence) {
          // Explicit rate
          ratePence = args.ratePence;
          breakdown = `${miles} miles @ ${ratePence}p/mile`;
        } else {
          const envRate = getDefaultRate();
          if (envRate) {
            // Env var rate
            ratePence = envRate;
            breakdown = `${miles} miles @ ${ratePence}p/mile (MILEAGE_RATE_PENCE)`;
          } else {
            // HMRC threshold logic
            const cumulative = args.cumulativeMilesYTD ?? 0;
            const remaining45p = Math.max(0, HMRC_THRESHOLD_MILES - cumulative);

            if (remaining45p >= miles) {
              ratePence = HMRC_RATE_HIGH_PENCE;
              breakdown = `${miles} miles @ ${HMRC_RATE_HIGH_PENCE}p/mile (HMRC)`;
            } else if (remaining45p <= 0) {
              ratePence = HMRC_RATE_LOW_PENCE;
              breakdown = `${miles} miles @ ${HMRC_RATE_LOW_PENCE}p/mile (HMRC, over ${HMRC_THRESHOLD_MILES.toLocaleString()} threshold)`;
            } else {
              // Split across threshold
              const highMiles = remaining45p;
              const lowMiles = miles - highMiles;
              const totalPence = Math.round(
                highMiles * HMRC_RATE_HIGH_PENCE + lowMiles * HMRC_RATE_LOW_PENCE
              );
              const amountPounds = (totalPence / 100).toFixed(2);

              const expense = await createExpense({
                categoryUrl: getMileageCategoryUrl(),
                datedOn: args.datedOn,
                description: `[MILEAGE] [${miles} miles] ${args.description} — ${journeyDetail}. ${highMiles} mi @ ${HMRC_RATE_HIGH_PENCE}p + ${lowMiles} mi @ ${HMRC_RATE_LOW_PENCE}p (crosses ${HMRC_THRESHOLD_MILES.toLocaleString()}-mile threshold)`,
                grossValue: amountPounds,
                currency: args.currency,
              });

              return {
                content: [
                  {
                    type: "text",
                    text: JSON.stringify(
                      {
                        success: true,
                        expenseId: expense.id,
                        miles,
                        amount: `${amountPounds}`,
                        breakdown: `${highMiles} mi @ ${HMRC_RATE_HIGH_PENCE}p + ${lowMiles} mi @ ${HMRC_RATE_LOW_PENCE}p`,
                        journey: journeyDetail,
                        cumulativeMilesAfter: cumulative + miles,
                      },
                      null,
                      2
                    ),
                  },
                ],
                structuredContent: {
                  success: true,
                  expenseId: expense.id,
                  miles,
                  amount: amountPounds,
                },
              };
            }
          }
        }

        const amountPence = Math.round(miles * ratePence);
        const amountPounds = (amountPence / 100).toFixed(2);

        const expense = await createExpense({
          categoryUrl: getMileageCategoryUrl(),
          datedOn: args.datedOn,
          description: `[MILEAGE] [${miles} miles] ${args.description} — ${journeyDetail}. ${breakdown}`,
          grossValue: amountPounds,
          currency: args.currency,
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  success: true,
                  expenseId: expense.id,
                  miles,
                  ratePence,
                  amount: amountPounds,
                  breakdown,
                  journey: journeyDetail,
                  cumulativeMilesAfter: args.cumulativeMilesYTD
                    ? args.cumulativeMilesYTD + miles
                    : undefined,
                },
                null,
                2
              ),
            },
          ],
          structuredContent: {
            success: true,
            expenseId: expense.id,
            miles,
            amount: amountPounds,
          },
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: handleFAError(err) }],
          isError: true,
        };
      }
    }
  );
}
