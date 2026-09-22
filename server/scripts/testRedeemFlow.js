/**
 * Smoke test — Sistem Order Baru (Automatic Redeem Code).
 *
 * Menjalankan ulang test #1-8 dari spec (Add Product kedua sistem, restock,
 * "beli", cek Available/Sold) SECARA OTOMATIS lewat model/service Mongoose
 * yang sama dipakai backend — bukan lewat HTTP, jadi tidak perlu server
 * Express menyala. Tetap butuh MongoDB asli (MONGODB_URI di .env).
 *
 * SEMUA data yang dibuat script ini diberi prefix "TEST-REDEEM-" dan
 * DIHAPUS LAGI di akhir (lihat cleanup()) — aman dijalankan berulang, tapi
 * tetap disarankan pakai database dev/staging, bukan production, karena
 * script ini benar-benar menulis ke database yang ditunjuk MONGODB_URI.
 *
 * Jalankan dari folder server/:
 *   node scripts/testRedeemFlow.js
 */
require("dotenv").config();
const mongoose = require("mongoose");
const Category = require("../models/Category");
const Product = require("../models/Product");
const Order = require("../models/Order");
const RedeemCode = require("../models/RedeemCode");
const redeemCodeService = require("../services/redeemCode.service");

const RUN_TAG = "TEST-REDEEM-" + Date.now();
let pass = 0;
let fail = 0;

function ok(label, condition, detail) {
  if (condition) {
    pass += 1;
    console.log("  ✅ " + label);
  } else {
    fail += 1;
    console.log("  ❌ " + label + (detail ? " — " + detail : ""));
  }
}

// Order asli dibuat lewat checkout + webhook payment; di sini cukup dokumen
// Order MINIMAL yang field-nya benar-benar dibaca claimCodesForOrder()
// (quantity, _id, customerId, orderCode) — supaya test ini murni menguji
// redeemCodeService, bukan seluruh flow checkout/payment gateway.
async function makeFakeOrder(product, quantity) {
  return Order.create({
    orderCode: RUN_TAG + "-" + Math.random().toString(36).slice(2, 8).toUpperCase(),
    customer: { name: "Test Buyer", email: "test@example.com", whatsapp: "081200000000" },
    product: { productId: product._id, name: product.name, price: product.price },
    quantity,
    total: product.price * quantity,
    status: "PAID",
    paymentStatus: "SUCCESS",
  });
}

async function run() {
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 10000 });
  console.log("Terhubung ke MongoDB. Menjalankan test dengan tag: " + RUN_TAG + "\n");

  let category, manualProduct, redeemProduct;
  const fakeOrders = [];

  try {
    /* ---------------------------------------------------- setup dasar --- */
    category = await Category.create({ name: RUN_TAG + " Category", slug: RUN_TAG.toLowerCase() + "-cat" });

    /* ---- Test #1: Add Product Sistem Lama ---- */
    console.log("Test #1 — Add Product Sistem Lama (MANUAL)");
    manualProduct = await Product.create({
      name: RUN_TAG + " Manual Product",
      slug: RUN_TAG.toLowerCase() + "-manual",
      categoryId: category._id,
      price: 10000,
      stock: 5,
    });
    ok("Produk baru tanpa orderSystem eksplisit otomatis MANUAL", manualProduct.orderSystem === "MANUAL");

    /* ---- Test #2: Add Product Sistem Baru ---- */
    console.log("\nTest #2 — Add Product Sistem Baru (REDEEM_CODE)");
    redeemProduct = await Product.create({
      name: RUN_TAG + " Redeem Product",
      slug: RUN_TAG.toLowerCase() + "-redeem",
      categoryId: category._id,
      price: 15000,
      stock: 0,
      orderSystem: "REDEEM_CODE",
      redeemInstructions: "Buka aplikasi, masukkan kode di menu Redeem.",
    });
    ok("Produk tersimpan dengan orderSystem REDEEM_CODE", redeemProduct.orderSystem === "REDEEM_CODE");
    ok("Stok awal 0 (belum ada code)", redeemProduct.stock === 0);

    /* ---- Test #3-4: Restock 10 code, Available harus 10 ---- */
    console.log("\nTest #3-4 — Restock 10 redeem code");
    const codes = Array.from({ length: 10 }, (_, i) => RUN_TAG + "-CODE-" + i);
    const restockResult = await redeemCodeService.restock(redeemProduct._id, codes.join("\n"));
    ok("10 code berhasil masuk (tidak ada yang di-skip)", restockResult.inserted === 10 && restockResult.skipped === 0, JSON.stringify(restockResult));
    ok("Stats Available = 10 setelah restock", restockResult.stats.available === 10 && restockResult.stats.total === 10);

    const productAfterRestock = await Product.findById(redeemProduct._id);
    ok(
      "Product.stock ikut tersinkron jadi 10 (dibaca checkout & Marketplace)",
      productAfterRestock.stock === 10,
      "stock=" + productAfterRestock.stock
    );

    // Validasi dedupe: restock ulang code yang SAMA harus di-skip semua, bukan
    // dobel tersimpan (spec 3: "Jangan menyimpan duplicate code").
    const dupeResult = await redeemCodeService.restock(redeemProduct._id, codes.slice(0, 3).join("\n"));
    ok("Restock ulang code yang sudah ada di-skip semua (tidak dobel)", dupeResult.inserted === 0 && dupeResult.skipped === 3, JSON.stringify(dupeResult));

    /* ---- Test #5-8: Customer membeli 1, Available -1 Sold +1 ---- */
    console.log("\nTest #5-8 — Simulasi 1 pembelian (claim code)");
    const order1 = await makeFakeOrder(redeemProduct, 1);
    fakeOrders.push(order1);
    const claim1 = await redeemCodeService.claimCodesForOrder(order1, productAfterRestock);
    ok("Tepat 1 code diklaim, tidak ada shortfall", claim1.claimed.length === 1 && claim1.shortfall === 0);

    const statsAfterBuy = await redeemCodeService.getStats(redeemProduct._id);
    ok("Available turun jadi 9", statsAfterBuy.available === 9, "available=" + statsAfterBuy.available);
    ok("Sold naik jadi 1", statsAfterBuy.sold === 1, "sold=" + statsAfterBuy.sold);

    const soldDoc = await RedeemCode.findOne({ productId: redeemProduct._id, status: "SOLD" });
    ok("Code yang terjual terhubung ke orderId yang benar", String(soldDoc.orderId) === String(order1._id));
    ok("soldAt terisi", Boolean(soldDoc.soldAt));

    const codesForOrder = await redeemCodeService.getCodesForOrder(order1._id);
    ok("Halaman transaksi customer akan melihat tepat 1 code untuk order ini", codesForOrder.length === 1 && codesForOrder[0] === soldDoc.code);

    /* ---- Bonus: dua pembelian bersamaan tidak boleh dapat code sama ---- */
    console.log("\nBonus — 2 customer membeli bersamaan (race condition)");
    const [orderA, orderB] = await Promise.all([makeFakeOrder(redeemProduct, 1), makeFakeOrder(redeemProduct, 1)]);
    fakeOrders.push(orderA, orderB);
    const [claimA, claimB] = await Promise.all([
      redeemCodeService.claimCodesForOrder(orderA, redeemProduct),
      redeemCodeService.claimCodesForOrder(orderB, redeemProduct),
    ]);
    const codeA = claimA.claimed[0] && claimA.claimed[0].code;
    const codeB = claimB.claimed[0] && claimB.claimed[0].code;
    ok("Kedua order sama-sama dapat 1 code", claimA.claimed.length === 1 && claimB.claimed.length === 1);
    ok("Code yang didapat kedua order BERBEDA (tidak ada duplikat)", Boolean(codeA) && Boolean(codeB) && codeA !== codeB, codeA + " vs " + codeB);

    /* ---- Bonus: stok habis harus melaporkan shortfall, bukan mengarang code ---- */
    console.log("\nBonus — stok redeem code habis");
    const statsBeforeDrain = await redeemCodeService.getStats(redeemProduct._id);
    const drainOrders = [];
    for (let i = 0; i < statsBeforeDrain.available; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const o = await makeFakeOrder(redeemProduct, 1);
      drainOrders.push(o);
      fakeOrders.push(o);
      // eslint-disable-next-line no-await-in-loop
      await redeemCodeService.claimCodesForOrder(o, redeemProduct);
    }
    const orderOverStock = await makeFakeOrder(redeemProduct, 1);
    fakeOrders.push(orderOverStock);
    const overClaim = await redeemCodeService.claimCodesForOrder(orderOverStock, redeemProduct);
    ok("Saat stok habis, claimCodesForOrder melaporkan shortfall (bukan mengarang code)", overClaim.claimed.length === 0 && overClaim.shortfall === 1);

    const finalStats = await redeemCodeService.getStats(redeemProduct._id);
    ok("Available akhirnya 0, Sold = Total", finalStats.available === 0 && finalStats.sold === finalStats.total);
  } catch (err) {
    fail += 1;
    console.error("\n💥 Test berhenti karena error tak terduga:", err);
  } finally {
    /* -------------------------------------------------------- cleanup --- */
    console.log("\nMembersihkan data test...");
    if (fakeOrders.length) await Order.deleteMany({ _id: { $in: fakeOrders.map((o) => o._id) } });
    if (redeemProduct) await RedeemCode.deleteMany({ productId: redeemProduct._id });
    if (redeemProduct) await Product.deleteOne({ _id: redeemProduct._id });
    if (manualProduct) await Product.deleteOne({ _id: manualProduct._id });
    if (category) await Category.deleteOne({ _id: category._id });
    console.log("Selesai dibersihkan — tidak ada data test yang tersisa di database.\n");

    console.log("======================================");
    console.log("HASIL: " + pass + " lolos, " + fail + " gagal");
    console.log("======================================");
    await mongoose.disconnect();
    process.exit(fail > 0 ? 1 : 0);
  }
}

run().catch((err) => {
  console.error("Gagal konek/menjalankan test:", err.message);
  process.exit(1);
});
