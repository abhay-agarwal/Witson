

// Aux function to flatten the traits structure returned by the User Modeling service
var flatten = function(/*object*/ tree) {
	var arr = [], f = function(t, level) {
		if (!t) return;

		if (level>0 && (!t.children || level!=2)) {
			arr.push({
				'name'   : t.name,
				'intensity': t.percentage ? Math.floor(t.percentage*100) : '0',
			});
		}
		if (t.children && t.id!='sbh') {
			for (var i=0; i<t.children.length; i++) {
				f(t.children[i], level+1);
			}
		}
	};
	f(tree, 0);
	return arr;	
};
module.exports.flat = flatten;