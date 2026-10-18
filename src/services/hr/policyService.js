// src/services/hr/policyService.js
// Which HR policy applies to whom. employee.hrPolicy, else the default policy
// (created on first use with the owner's chosen rules — see models/hrPolicy.js).
const mongoose = require('mongoose');
const HrPolicy = require('../../models/hrPolicy');

const TTL_MS = 30 * 1000;
const cache = new Map(); // id | 'default' -> { at, policy }

const fresh = (key) => {
  const hit = cache.get(key);
  return hit && Date.now() - hit.at < TTL_MS ? hit.policy : null;
};
const remember = (key, policy) => {
  cache.set(key, { at: Date.now(), policy });
  return policy;
};

function clearCache() {
  cache.clear();
}

/** The default policy (created when there is none). */
async function getDefault() {
  const hit = fresh('default');
  if (hit) return hit;
  let p = await HrPolicy.findOne({ isDefault: true, isActive: true }).lean();
  if (!p) {
    p = await HrPolicy.findOneAndUpdate(
      { isDefault: true },
      {
        $setOnInsert: {
          name: 'Standard staff',
          description: 'Grace 10 min · 3 lates = 1 day cut · absent = 1 day (salary ÷ 30) · overtime at the normal rate after approval · till shortage cut after approval.',
          isActive: true,
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    ).lean();
  }
  return remember('default', p);
}

/** A policy by id; missing / inactive / deleted -> the default policy. */
async function getPolicy(id) {
  if (!id || !mongoose.Types.ObjectId.isValid(String(id))) return getDefault();
  const key = String(id);
  const hit = fresh(key);
  if (hit) return hit;
  const p = await HrPolicy.findOne({ _id: key, isActive: true }).lean();
  return p ? remember(key, p) : getDefault();
}

const policyFor = (employee) => getPolicy(employee && employee.hrPolicy);

/** Map employeeId -> policy for many employees (one query per distinct policy). */
async function policiesFor(employees) {
  const out = new Map();
  for (const e of employees || []) out.set(String(e._id), await policyFor(e));
  return out;
}

module.exports = { getDefault, getPolicy, policyFor, policiesFor, clearCache };
