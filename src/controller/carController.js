// src/controller/carController.js
const Car = require('../models/car');

const carController = {
  // GET /cars - list all cars
  listCars: async (req, res) => {
    try {
      const cars = await Car.find().sort({ make: 1, model: 1, year: -1, variant: 1 });
      return res.status(200).json({ message: 'Cars fetched successfully', data: cars });
    } catch (error) {
      console.error('List cars error:', error);
      return res.status(400).json({ message: 'Error fetching cars', error: error.message });
    }
  },

  // POST /cars - create a new car
  createCar: async (req, res) => {
    try {
      let { make, model, variant = '', year = null, active = true } = req.body || {};

      if (!make || !model) {
        return res.status(400).json({ message: 'make and model are required' });
      }

      make = String(make).trim();
      model = String(model).trim();
      variant = String(variant || '').trim();
      year = year ? Number(year) : null;
      active = Boolean(active);

      const created = await Car.create({ make, model, variant, year, active });
      return res.status(201).json({ message: 'Car created successfully', data: created });
    } catch (error) {
      if (error && error.code === 11000) {
        return res
          .status(409)
          .json({ message: 'This make/model/variant/year combination already exists' });
      }
      console.error('Create car error:', error);
      return res.status(400).json({ message: 'Error creating car', error: error.message });
    }
  },

  // PUT /cars/:id - update a car
  updateCar: async (req, res) => {
    try {
      const { id } = req.params;
      const payload = req.body || {};

      const updates = {};
      if (typeof payload.make !== 'undefined') updates.make = String(payload.make).trim();
      if (typeof payload.model !== 'undefined') updates.model = String(payload.model).trim();
      if (typeof payload.variant !== 'undefined') updates.variant = String(payload.variant || '').trim();
      if (typeof payload.year !== 'undefined') updates.year = payload.year ? Number(payload.year) : null;
      if (typeof payload.active !== 'undefined') updates.active = Boolean(payload.active);

      const updated = await Car.findByIdAndUpdate(
        id,
        { $set: updates },
        { new: true, runValidators: true }
      );

      if (!updated) {
        return res.status(404).json({ message: 'Car not found' });
      }

      return res.status(200).json({ message: 'Car updated successfully', data: updated });
    } catch (error) {
      if (error && error.code === 11000) {
        return res
          .status(409)
          .json({ message: 'This make/model/variant/year combination already exists' });
      }
      console.error('Update car error:', error);
      return res.status(400).json({ message: 'Error updating car', error: error.message });
    }
  },

  // DELETE /cars/:id - delete a car
  deleteCar: async (req, res) => {
    try {
      const { id } = req.params;
      const deleted = await Car.softDeleteById(id, req.user?._id || null);
      if (!deleted) {
        return res.status(404).json({ message: 'Car not found' });
      }
      return res.status(200).json({ message: 'Car deleted successfully', id });
    } catch (error) {
      console.error('Delete car error:', error);
      return res.status(400).json({ message: 'Error deleting car', error: error.message });
    }
  },
};

module.exports = carController;
