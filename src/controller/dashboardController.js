// src/controller/dashboardController.js
// GET /dashboard?timeRange=today|week|month|year — numbers for the admin dashboard.
const dashboardService = require('../services/dashboardService');

const TIME_RANGES = ['today', 'week', 'month', 'year'];

module.exports = {
  async getDashboardData(req, res) {
    try {
      const timeRange = TIME_RANGES.includes(req.query.timeRange) ? req.query.timeRange : 'week';
      res.status(200).json(await dashboardService.getDashboardData(timeRange));
    } catch (error) {
      console.error('Error fetching dashboard data:', error);
      res.status(500).json({ error: 'Failed to fetch dashboard data' });
    }
  },
};
