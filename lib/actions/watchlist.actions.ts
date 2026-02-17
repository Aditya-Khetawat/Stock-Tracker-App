"use server";

import { connectToDatabase } from "@/database/mongoose";
import { Watchlist } from "@/database/models/watchlist.model";
import { auth } from "@/lib/better-auth/auth";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";

const getAuthenticatedUser = async () => {
  const session = await auth.api.getSession({ headers: await headers() });

  if (!session?.user) {
    redirect("/sign-in");
  }

  return session.user;
};

export async function addToWatchlist({
  symbol,
  company,
}: {
  symbol: string;
  company: string;
}) {
  try {
    const user = await getAuthenticatedUser();

    const normalizedSymbol = symbol?.trim().toUpperCase();
    const normalizedCompany = company?.trim();

    if (!normalizedSymbol) {
      return { success: false, error: "Stock symbol is required." };
    }

    if (!normalizedCompany) {
      return { success: false, error: "Company name is required." };
    }

    await connectToDatabase();

    const existing = await Watchlist.findOne({
      userId: user.id,
      symbol: normalizedSymbol,
    }).lean();

    if (existing) {
      return { success: true, message: "Stock is already in your watchlist." };
    }

    await Watchlist.create({
      userId: user.id,
      symbol: normalizedSymbol,
      company: normalizedCompany,
    });

    revalidatePath("/watchlist");

    return { success: true };
  } catch (err) {
    console.error("addToWatchlist error:", err);
    return { success: false, error: "Failed to add stock to watchlist." };
  }
}

export async function removeFromWatchlist(symbol: string) {
  try {
    const user = await getAuthenticatedUser();
    const normalizedSymbol = symbol?.trim().toUpperCase();

    if (!normalizedSymbol) {
      return { success: false, error: "Stock symbol is required." };
    }

    await connectToDatabase();

    const result = await Watchlist.deleteOne({
      userId: user.id,
      symbol: normalizedSymbol,
    });

    revalidatePath("/watchlist");

    if (!result.deletedCount) {
      return { success: false, error: "Stock not found in watchlist." };
    }

    return { success: true };
  } catch (err) {
    console.error("removeFromWatchlist error:", err);
    return { success: false, error: "Failed to remove stock from watchlist." };
  }
}

export async function getUserWatchlist() {
  try {
    const user = await getAuthenticatedUser();

    await connectToDatabase();

    const items = await Watchlist.find({ userId: user.id })
      .sort({ addedAt: -1 })
      .lean();

    return items.map((item) => ({
      symbol: String(item.symbol),
      company: String(item.company),
      addedAt: item.addedAt,
    }));
  } catch (err) {
    console.error("getUserWatchlist error:", err);
    return [];
  }
}

export async function getWatchlistWithData(): Promise<StockWithData[]> {
  try {
    const user = await getAuthenticatedUser();

    await connectToDatabase();

    const items = await Watchlist.find({ userId: user.id })
      .sort({ addedAt: -1 })
      .lean();

    if (items.length === 0) return [];

    // Fetch live data for each stock
    const token =
      process.env.FINNHUB_API_KEY ?? process.env.NEXT_PUBLIC_FINNHUB_API_KEY;
    if (!token) {
      console.error("FINNHUB API key not configured");
      return items.map((item) => ({
        userId: user.id,
        symbol: String(item.symbol),
        company: String(item.company),
        addedAt: item.addedAt,
      }));
    }

    const enrichedStocks = await Promise.all(
      items.map(async (item) => {
        const symbol = String(item.symbol);
        try {
          // Fetch quote data
          const quoteRes = await fetch(
            `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${token}`,
            { next: { revalidate: 60 } },
          );
          const quote = await quoteRes.json();

          // Fetch profile for market cap
          const profileRes = await fetch(
            `https://finnhub.io/api/v1/stock/profile2?symbol=${encodeURIComponent(symbol)}&token=${token}`,
            { next: { revalidate: 3600 } },
          );
          const profile = await profileRes.json();

          // Fetch metrics for P/E ratio
          const metricsRes = await fetch(
            `https://finnhub.io/api/v1/stock/metric?symbol=${encodeURIComponent(symbol)}&metric=all&token=${token}`,
            { next: { revalidate: 3600 } },
          );
          const metrics = await metricsRes.json();

          const currentPrice = quote?.c || 0;
          const changePercent = quote?.dp || 0;
          const marketCap = profile?.marketCapitalization || 0;
          const peRatio =
            metrics?.metric?.peBasicExclExtraTTM || metrics?.metric?.peTTM || 0;

          // Format values
          const priceFormatted =
            currentPrice > 0 ? `$${currentPrice.toFixed(2)}` : "N/A";
          const changeFormatted =
            changePercent !== 0
              ? `${changePercent > 0 ? "+" : ""}${changePercent.toFixed(2)}%`
              : "N/A";
          const marketCapFormatted =
            marketCap > 0
              ? marketCap >= 1000
                ? `$${(marketCap / 1000).toFixed(2)}T`
                : `$${marketCap.toFixed(2)}B`
              : "N/A";
          const peFormatted = peRatio > 0 ? peRatio.toFixed(2) : "N/A";

          return {
            userId: user.id,
            symbol,
            company: String(item.company),
            addedAt: item.addedAt,
            currentPrice,
            changePercent,
            priceFormatted,
            changeFormatted,
            marketCap: marketCapFormatted,
            peRatio: peFormatted,
          };
        } catch (err) {
          console.error(`Error fetching data for ${symbol}:`, err);
          return {
            userId: user.id,
            symbol,
            company: String(item.company),
            addedAt: item.addedAt,
            priceFormatted: "N/A",
            changeFormatted: "N/A",
            marketCap: "N/A",
            peRatio: "N/A",
          };
        }
      }),
    );

    return enrichedStocks;
  } catch (err) {
    console.error("getWatchlistWithData error:", err);
    return [];
  }
}

export async function getWatchlistSymbolsByEmail(
  email: string,
): Promise<string[]> {
  if (!email) return [];

  try {
    const mongoose = await connectToDatabase();
    const db = mongoose.connection.db;
    if (!db) throw new Error("MongoDB connection not found");

    // Better Auth stores users in the "user" collection
    const user = await db
      .collection("user")
      .findOne<{ _id?: unknown; id?: string; email?: string }>({ email });

    if (!user) return [];

    const userId = (user.id as string) || String(user._id || "");
    if (!userId) return [];

    const items = await Watchlist.find({ userId }, { symbol: 1 }).lean();
    return items.map((i) => String(i.symbol));
  } catch (err) {
    console.error("getWatchlistSymbolsByEmail error:", err);
    return [];
  }
}
