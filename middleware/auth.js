'use strict';

exports.requireAuth = (req, res, next) => {
  if (req.session?.storeId) return next();
  const wantsJson = req.headers['accept']?.includes('application/json');
  return wantsJson
    ? res.status(401).json({ success: false, message: 'Unauthorized. Please sign in.', redirect: '/login' })
    : res.redirect('/login');
};

exports.requireAdmin = (req, res, next) => {
  if (req.session?.storeId && req.session?.isAdmin) return next();
  const wantsJson = req.headers['accept']?.includes('application/json');
  return wantsJson
    ? res.status(403).json({ success: false, message: 'Forbidden. Admin access required.' })
    : res.redirect('/login');
};
