// Employees, contract letters, assets (/api/employees, /api/contract-templates, /api/assets, /api/asset-categories). OWNER: HR & Assets module.
// Mounted at /api by routes/modules/index.js — define FULL sub-paths here,
// e.g. router.get('/racks', ...staff, can('racks', 'view'), handle(ctrl.list)).
//
// Actions on an existing record (status, documents, maintenance, dispose,
// "contract issued") need `edit`. Permission checks run before uploads.
const express = require('express');
const { staff, can, superAdmin, handle } = require('./_access'); // eslint-disable-line no-unused-vars
const { uploadSingle, uploadArray, documentUploadArray } = require('../../helper/upload');
const employees = require('../../controller/store/employeeController');
const contracts = require('../../controller/store/contractController');
const assets = require('../../controller/store/assetRegisterController');

const router = express.Router();

// Multer errors (not an image, too big) as a 400 JSON answer instead of a 500.
const upload = (mw) => (req, res, next) =>
  mw(req, res, (err) => {
    if (!err) return next();
    const tooBig = err.code === 'LIMIT_FILE_SIZE';
    return res.status(400).json({
      success: false,
      message: tooBig ? 'File is too large (max 5 MB)' : err.message || 'Upload failed',
      code: tooBig ? 'FILE_TOO_LARGE' : 'UPLOAD_FAILED',
    });
  });

// ----- Employees -----
router.get('/employees', ...staff, can('employees', 'view'), handle(employees.list));
router.get('/employees/linkable-users', ...staff, can('employees', 'view'), handle(employees.linkableUsers));
router.post('/employees', ...staff, can('employees', 'create'), handle(employees.create));
router.get('/employees/:id', ...staff, can('employees', 'view'), handle(employees.get));
router.put('/employees/:id', ...staff, can('employees', 'edit'), handle(employees.update));
router.post('/employees/:id/status', ...staff, can('employees', 'edit'), handle(employees.setStatus));
router.delete('/employees/:id', ...staff, can('employees', 'delete'), handle(employees.remove));
router.post('/employees/:id/photo', ...staff, can('employees', 'edit'), upload(uploadSingle('photo')), handle(employees.uploadPhoto));
router.post('/employees/:id/documents', ...staff, can('employees', 'edit'), upload(documentUploadArray('files', 5)), handle(employees.uploadDocuments)); // images or PDF
router.delete('/employees/:id/documents/:docId', ...staff, can('employees', 'edit'), handle(employees.removeDocument));
// Staff login for an employee: create + link (needs staff:create AND employees:edit), unlink.
router.post('/employees/:id/login', ...staff, can('staff', 'create'), can('employees', 'edit'), handle(employees.createLogin));
router.delete('/employees/:id/login', ...staff, can('employees', 'edit'), handle(employees.removeLogin));

// ----- Contract letters (render/issue also need employees:edit, checked in the service) -----
router.get('/employees/:id/contract', ...staff, can('employees', 'view'), handle(contracts.render));
router.post('/employees/:id/contract/issue', ...staff, can('employees', 'edit'), handle(contracts.issue));
router.get('/contract-templates', ...staff, can('employees', 'view'), handle(contracts.listTemplates));
router.post('/contract-templates', ...staff, can('employees', 'create'), handle(contracts.createTemplate));
router.get('/contract-templates/:id', ...staff, can('employees', 'view'), handle(contracts.getTemplate));
router.put('/contract-templates/:id', ...staff, can('employees', 'edit'), handle(contracts.updateTemplate));
router.delete('/contract-templates/:id', ...staff, can('employees', 'delete'), handle(contracts.removeTemplate));

// ----- Asset categories -----
router.get('/asset-categories', ...staff, can('assets', 'view'), handle(assets.listCategories));
router.post('/asset-categories', ...staff, can('assets', 'create'), handle(assets.createCategory));
router.put('/asset-categories/:id', ...staff, can('assets', 'edit'), handle(assets.updateCategory));
router.delete('/asset-categories/:id', ...staff, can('assets', 'delete'), handle(assets.removeCategory));

// ----- Assets -----
router.get('/assets', ...staff, can('assets', 'view'), handle(assets.list));
router.get('/assets/summary', ...staff, can('assets', 'view'), handle(assets.summary));
router.get('/assets/export', ...staff, can('assets', 'export'), handle(assets.exportCsv));
router.post('/assets', ...staff, can('assets', 'create'), handle(assets.create));
router.get('/assets/:id', ...staff, can('assets', 'view'), handle(assets.get));
router.put('/assets/:id', ...staff, can('assets', 'edit'), handle(assets.update));
router.post('/assets/:id/photos', ...staff, can('assets', 'edit'), upload(uploadArray('photos', 5)), handle(assets.uploadPhotos));
router.post('/assets/:id/maintenance', ...staff, can('assets', 'edit'), handle(assets.addMaintenance));
router.post('/assets/:id/dispose', ...staff, can('assets', 'edit'), handle(assets.dispose));
router.post('/assets/:id/status', ...staff, can('assets', 'edit'), handle(assets.setStatus));
router.delete('/assets/:id', ...staff, can('assets', 'delete'), handle(assets.remove));

module.exports = router;
