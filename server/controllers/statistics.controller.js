const Order = require("../models/Order");
const Product = require("../models/Product");
const Rating = require("../models/Rating");
const Customer = require("../models/Customer");
const asyncHandler = require("../utils/asyncHandler");

// PUBLIC — every number here is a real aggregate query, never a hardcoded/random value.
const getPublic = asyncHandler(async (req, res) => {
  const [totalProdukTerjualAgg, totalProduk, successfulOrders, totalBuyer, ratingAgg] = await Promise.all([
    Order.aggregate([{ $match: { status: "PAID" } }, { $group: { _id: null, qty: { $sum: "$quantity" } } }]),
    Product.countDocuments({ status: "active" }),
    Order.countDocuments({ status: "PAID" }),
    Customer.countDocuments({ totalSuccessfulOrders: { $gt: 0 } }).then(async (count) => {
      // totalSuccessfulOrders may not be pre-maintained; fall back to distinct buyers with a PAID order.
      if (count > 0) return count;
      const distinctBuyers = await Order.distinct("customer.email", { status: "PAID" });
      return distinctBuyers.length;
    }),
    Rating.aggregate([{ $match: { status: "approved" } }, { $group: { _id: null, avg: { $avg: "$rating" }, count: { $sum: 1 } } }]),
  ]);

  res.json({
    status: true,
    data: {
      totalProdukTerjual: totalProdukTerjualAgg[0]?.qty || 0,
      totalProduk,
      successfulOrders,
      totalBuyer,
      averageRating: ratingAgg[0] ? Number(ratingAgg[0].avg.toFixed(1)) : 0,
      ratingCount: ratingAgg[0]?.count || 0,
    },
  });
});

module.exports = { getPublic };
