const mongoose = require("mongoose");
const Customer = require("../models/Customer");
const Order = require("../models/Order");
const asyncHandler = require("../utils/asyncHandler");
const { AppError } = require("../middlewares/errorHandler");

/**
 * ADMIN — customer list.
 * Every column (jumlah order, total belanja, terakhir aktif) is derived from real
 * Order documents via aggregation, so the table can never drift from the orders data.
 */
const listAdmin = asyncHandler(async (req, res) => {
  const { search, page = 1, limit = 30 } = req.query;

  const pageNum = Math.max(1, Number(page));
  const limitNum = Math.min(100, Math.max(1, Number(limit)));

  const match = {};
  if (search && String(search).trim()) {
    const rx = new RegExp(String(search).trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    match.$or = [{ name: rx }, { email: rx }, { whatsapp: rx }];
  }

  const pipeline = [
    { $match: match },
    {
      $lookup: {
        from: "orders",
        localField: "_id",
        foreignField: "customerId",
        as: "orders",
      },
    },
    {
      $addFields: {
        paidOrders: {
          $filter: { input: "$orders", as: "o", cond: { $eq: ["$$o.status", "PAID"] } },
        },
      },
    },
    {
      $addFields: {
        orderCount: { $size: "$orders" },
        paidOrderCount: { $size: "$paidOrders" },
        totalSpent: { $sum: { $map: { input: "$paidOrders", as: "o", in: "$$o.total" } } },
        lastOrderAt: { $max: "$orders.createdAt" },
      },
    },
    { $project: { orders: 0, paidOrders: 0 } },
    { $sort: { lastOrderAt: -1, createdAt: -1 } },
    { $skip: (pageNum - 1) * limitNum },
    { $limit: limitNum },
  ];

  const [customers, total] = await Promise.all([
    Customer.aggregate(pipeline),
    Customer.countDocuments(match),
  ]);

  res.json({ status: true, data: customers, pagination: { page: pageNum, limit: limitNum, total } });
});

// ADMIN — single customer + their order history.
const getAdminById = asyncHandler(async (req, res) => {
  const { id } = req.params;
  if (!mongoose.isValidObjectId(id)) throw new AppError("Customer tidak ditemukan.", 404);

  const customer = await Customer.findById(id);
  if (!customer) throw new AppError("Customer tidak ditemukan.", 404);

  const orders = await Order.find({ customerId: customer._id }).sort({ createdAt: -1 }).limit(50);

  res.json({ status: true, data: { customer, orders } });
});

module.exports = { listAdmin, getAdminById };
