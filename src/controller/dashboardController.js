// src/controller/dashboardController.js
// GET /dashboard?range=today|yesterday|7d|30d|month|year — the owner's dashboard.
// (Old ?timeRange=week still works.) Blocks follow the user's permissions.
const dashboardService = require('../services/dashboardService');

module.exports = {
  async getDashboardData(req, res) {
    try {
      const range = req.query.range || req.query.timeRange || 'today';
      res.status(200).json({ success: true, data: await dashboardService.getDashboardData(req, String(range)) });
    } catch (error) {
      console.error('Error fetching dashboard data:', error);
      res.status(error.status || 500).json({ success: false, message: error.status ? error.message : 'Failed to fetch dashboard data' });
    }
  },
};
