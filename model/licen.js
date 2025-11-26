const mongoose = require('mongoose')
const Schema = mongoose.Schema

const account = new Schema(
  {
    accountNumber: { type: String },
    license: { type: String },
    expireDate: { type: String },
    status: { type: String, default: 'valid' },
    lastNearlyExpiredNotifiedAt: { type: String },
    notified: { type: String }
  },
  {
    timestamps: true
  }
)
module.exports = mongoose.model('customeraccounts', account)
