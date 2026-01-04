// Simple API key authentication middleware
const express = require('express')
const HTTPStatus = require('http-status')
const cron = require('node-cron')
const helmet = require('helmet')
const rateLimit = require('express-rate-limit')
const mongoSanitize = require('express-mongo-sanitize')
const app = express()

// Trust the first proxy (Nginx) to fix rate-limit IP detection
app.set('trust proxy', 1)

require('dotenv').config()

const port = 5800
const cors = require('cors')
const bodyParser = require('body-parser')
const mongoose = require('mongoose')
const licen = require('./model/licen')

// Security Middleware
app.use(helmet()) // Set security HTTP headers
app.use(mongoSanitize()) // Data sanitization against NoSQL query injection

// Rate Limiting
const limiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 requests per windowMs
  message: 'Too many requests from this IP, please try again later'
})
app.use(limiter)

app.use(cors())
app.use(bodyParser.json())
app.use(bodyParser.urlencoded({ extended: false }))
const connectionString = `${process.env.DB}` + `${process.env.NAME}`

// ---------------- Helper Functions (expiration handling) ----------------
// Parse Thai Buddhist calendar date (DD/MM/YYYY[ HH:mm]) to JS Date
const parseThaiExpireDate = (dateStr) => {
  if (!dateStr || typeof dateStr !== 'string') return null
  let datePart = dateStr
  let timePart = '00:00'
  if (dateStr.includes(' ')) {
    ;[datePart, timePart] = dateStr.split(' ')
  }
  const [day, month, yearThai] = datePart.split('/').map(Number)
  if (!day || !month || !yearThai) return null
  const yearGregorian = yearThai - 543
  let hour = 0,
    minute = 0
  if (timePart && timePart.includes(':')) {
    const timeSplit = timePart.split(':')
    hour = Number(timeSplit[0]) || 0
    minute = Number(timeSplit[1]) || 0
  }
  return new Date(yearGregorian, month - 1, day, hour, minute, 0)
}

// Evaluate one license document, update status if needed, and build response object.
// Keeps custom statuses (e.g., 'revoked') untouched unless determining expiry.
async function evaluateAndSyncLicense(doc) {
  const now = new Date()
  let expireDateGregorian = null
  if (doc.expireDate) {
    if (typeof doc.expireDate === 'string') {
      expireDateGregorian = parseThaiExpireDate(doc.expireDate)
    } else if (doc.expireDate instanceof Date) {
      expireDateGregorian = doc.expireDate
    }
  }

  // If we can evaluate an expiry date
  if (expireDateGregorian) {
    const msInDay = 24 * 60 * 60 * 1000
    const daysToExpire = Math.floor((expireDateGregorian - now) / msInDay)

    if (expireDateGregorian <= now) {
      let didUpdate = false
      if (doc.status !== 'expired') {
        // Only overwrite if status is (valid|expired|invalid) - preserve suspended, revoked, etc.
        if (
          ['valid', 'expired', 'invalid', 'nearly_expired'].includes(doc.status)
        ) {
          await doc.updateOne({
            $set: { status: 'expired' },
            $unset: { lastNearlyExpiredNotifiedAt: 1 }
          })
          didUpdate = true
        }
      }
      return {
        status: 'invalid',
        reason: 'expired',
        expireDate: doc.expireDate,
        didUpdate
      }
    } else if (daysToExpire >= 0 && daysToExpire < 3) {
      let didUpdate = false
      if (doc.status !== 'nearly_expired') {
        if (
          ['valid', 'expired', 'invalid', 'nearly_expired'].includes(doc.status)
        ) {
          await doc.updateOne({
            $set: { status: 'nearly_expired' },
            $unset: { notified: 1 }
          })
          didUpdate = true
        }
      }
      return {
        status: 'valid',
        reason: 'expires_soon',
        daysToExpire,
        expireDate: doc.expireDate,
        expireDateThai: doc.expireDateThai,
        didUpdate,
        oldStatus: doc.status,
        newStatus: 'nearly_expired'
      }
    } else {
      if (doc.status !== 'valid') {
        // Only overwrite if status is (valid|expired|invalid|nearly_expired) - preserve suspended, revoked, etc.
        if (
          ['valid', 'expired', 'invalid', 'nearly_expired'].includes(doc.status)
        ) {
          await doc.updateOne({
            $set: { status: 'valid' },
            $unset: { notified: 1, lastNearlyExpiredNotifiedAt: 1 }
          })
        }
      }
      return {
        status: 'valid',
        expireDate: doc.expireDate,
        expireDateThai: doc.expireDateThai
      }
    }
  }

  // No parsable expiry date -> return current status & note
  return {
    status: doc.status || 'valid',
    expireDate: doc.expireDate || null,
    expireDateThai: doc.expireDateThai,
    note: 'no-expire-date'
  }
}

console.log('connectionString', connectionString)
mongoose
  .connect(connectionString, {
    useNewUrlParser: true
  })
  .then(() => console.log('MongoDB connected successfully'))
  .catch((err) => console.error('Error connecting to MongoDB:', err))

// app.post('/license_api', apiKeyAuth, async (req, res) => {
app.post('/license_api', async (req, res) => {
  try {
    const body = req.body
    // 1. Body must be an object
    if (!body || typeof body !== 'object') {
      return res.status(400).json({ error: 'Invalid request body' })
    }

    // 2. Reject ANY extra fields
    const allowedKeys = ['account', 'licenes', 'botversion']
    for (const key of Object.keys(body)) {
      if (!allowedKeys.includes(key)) {
        return res.status(400).json({ error: 'Extra fields not allowed' })
      }
    }
    // 3. Check required fields exist
    if (!body.account || !body.licenes) {
      return res.status(400).json({ error: 'Missing required fields' })
    }

    // 4. Length limits
    if (body.account.length > 20)
      return res.status(400).json({ error: 'Account too long' })
    if (body.licenes.length > 50)
      return res.status(400).json({ error: 'License too long' })

    // 5. Pattern validation
    // Accept numbers or DEMO
    if (!/^(DEMO|[0-9]+)$/.test(body.account)) {
      return res.status(400).json({ error: 'Invalid account format' })
    }

    if (!/^[A-Z0-9\-]+$/.test(body.licenes)) {
      return res.status(400).json({ error: 'Invalid license format' })
    }

    const { account, licenes } = req.body

    const demoDoc = await licen.findOne({
      accountNumber: 'DEMO',
      license: licenes
    })
    if (demoDoc) {
      // Check for suspended or other non-standard statuses first
      if (!['valid', 'expired', 'invalid'].includes(demoDoc.status)) {
        return res.status(HTTPStatus.OK).json({
          status: 'invalid',
          reason: demoDoc.status,
          expireDate: demoDoc.expireDate,
          expireDateThai: demoDoc.expireDateThai
        })
      }
      const demoResult = await evaluateAndSyncLicense(demoDoc)
      return res.status(HTTPStatus.OK).json(demoResult)
    }

    // Normal account
    const userDoc = await licen.findOne({
      accountNumber: account,
      license: licenes
    })
    if (!userDoc) {
      // Fallback: account not found but license exists -> treat as demo usage
      const licenseOnlyDoc = await licen.findOne({ license: licenes })
      if (licenseOnlyDoc && licenseOnlyDoc.accountNumber === 'DEMO') {
        const assumed = await evaluateAndSyncLicense(licenseOnlyDoc)
        return res.status(HTTPStatus.OK).json({
          ...assumed,
          assumedDemo: true,
          reason: assumed.reason || 'account-not-found-demo-assumed'
        })
      }
      return res
        .status(HTTPStatus.OK)
        .json({ status: 'invalid', reason: 'not found' })
    }

    // If status already something other than valid/expired/invalid/nearly_expired (like revoked), return immediately
    if (
      !['valid', 'expired', 'invalid', 'nearly_expired'].includes(
        userDoc.status
      )
    ) {
      return res.status(HTTPStatus.OK).json({
        status: 'invalid',
        reason: userDoc.status,
        expireDate: userDoc.expireDate,
        expireDateThai: userDoc.expireDateThai
      })
    }

    const result = await evaluateAndSyncLicense(userDoc)
    return res.status(HTTPStatus.OK).json(result)
  } catch (error) {
    console.error('Error processing /license_api request:', error)
    return res.status(HTTPStatus.INTERNAL_SERVER_ERROR).json({
      error: error
    })
  }
})

// Function to check all licenses logic
async function checkAllLicensesLogic() {
  console.log('Starting scheduled license check...')
  const allDocs = await licen.find({})
  let processedCount = 0
  const updates = []

  for (const doc of allDocs) {
    // We only want to auto-update statuses that are time-dependent
    // i.e. valid, expired, nearly_expired.
    // If it's 'suspended' or 'revoked', evaluateAndSyncLicense usually preserves it,
    // but let's just call evaluateAndSyncLicense which handles logic safely.
    const result = await evaluateAndSyncLicense(doc)
    if (result.didUpdate) {
      updates.push({
        accountNumber: doc.accountNumber,
        license: doc.license,
        oldStatus: result.oldStatus,
        newStatus: result.newStatus
      })
    }
    processedCount++
  }

  console.log(
    `Finished checking ${processedCount} licenses. Updates: ${updates.length}`
  )
  return { processedCount, updates }
}

// Schedule task to run every 30 minutes
cron.schedule('*/30 * * * *', async () => {
  try {
    await checkAllLicensesLogic()
  } catch (error) {
    console.error('Error in scheduled license check:', error)
  }
})

// New endpoint to check and update status for ALL accounts
// Can be called manually or by external cron
app.get('/check_all_licenses', async (req, res) => {
  try {
    const { processedCount, updates } = await checkAllLicensesLogic()
    return res.status(HTTPStatus.OK).json({
      message: 'All licenses checked and synced.',
      totalChecked: processedCount,
      updatesCount: updates.length,
      updates
    })
  } catch (error) {
    console.error('Error in /check_all_licenses:', error)
    return res
      .status(HTTPStatus.INTERNAL_SERVER_ERROR)
      .json({ error: error.message })
  }
})

// Error handling middleware for JSON parsing errors
app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    return res.status(400).json({ error: 'Invalid JSON in request body' })
  }
  next(err)
})

app.listen(port, () => {
  console.log(`Example app listening on port ${port}`)
})
