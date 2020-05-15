const camelCase = require( 'camelcase' );
const fs = require( 'fs' );
const glob = require( 'glob' );
const murmurhash = require( './murmur' );
const normalizePath = require( 'normalize-path' );
const parser = require( '@babel/parser' );
const path = require( 'path' );
const traverse = require( '@babel/traverse' ).default;
const { watch } = require( 'chokidar' );
const { runQuery } = require( './index' );
const { reporter } = require( './utils' );

// TODO
const ROOT = process.env.INIT_CWD;
const GROQ_DIR = process.env.NODE_ENV === 'development' ? `${ROOT}/.cache/groq` : `${ROOT}/public/static/groq`;
const customBabelConfig = `${ROOT}/.babelrc`
let babelConfig = !! fs.existsSync( customBabelConfig ) ? fs.readFileSync( customBabelConfig, 'utf8' ) : null;
if( !! babelConfig ) {
  babelConfig = JSON.parse( babelConfig );
}


/**
 * Here's where we extract and run all initial queries.
 * Also sets up a watcher to re-run queries during dev when files change.fcache
 *
 * Runs in right after schema creation and before createPages.
 */
exports.resolvableExtensions = async ( { graphql, actions, cache, getNodes, traceId, store, plugins }, plugin ) => {

  if( !! fs.existsSync( GROQ_DIR ) ) {
    fs.rmdirSync( GROQ_DIR, { recursive: true } );
  }
  fs.mkdirSync( GROQ_DIR );


  // Cache fragments.
  const fragmentsDir = !! plugin.fragmentsDir ? path.join( ROOT, plugin.fragmentsDir ) : null;

  if( !! fragmentsDir ) {
    cacheFragments( fragmentsDir, cache );
  }

  // Extract initial queries.
  const intitialNodes = getNodes();

  extractQueries( { nodes: intitialNodes, traceId, cache } );


  // For now watching all files to re-extract queries.
  // Right now there doesn't seem to be a way to watch for build updates using Gatsby's public node apis.
  // Created a ticket in github to explore option here.
  const watcher = watch( `${ROOT}/src/**/*.js` );

  watcher.on( 'change', async ( filePath ) => {

    // Recache if this was a change within fragments directory.
    if( !! fragmentsDir && filePath.includes( fragmentsDir ) ) {

      await cacheFragments( fragmentsDir, cache );

      //TODO need to figure out a way to refresh page with new data.
      reporter.info( `DON'T FORGET TO RESAVE FILES WITH UPDATED FRAGMENT!` );

    }

    // Get info for file that was changed.
    const fileContents = fs.readFileSync( filePath, 'utf8' );

    // Check if file has either page or static queries.
    const pageQueryMatch = /export const groqQuery = /.exec( fileContents );
    const staticQueryMatch = /useGroqQuery/.exec( fileContents );
    if( ! pageQueryMatch && ! staticQueryMatch ) {
      return;
    }

    reporter.info( 'Re-processing groq queries...' );

    // Get updated nodes to query against.
    const nodes = getNodes();

    // Run page queries.
    if( pageQueryMatch ) {

      const { deletePage, createPage } = actions;
      const { pages } = store.getState();

      // First we need to reprocess the page query.
      const processedPageQuery = await processFilePageQuery( filePath, nodes, cache );

      if( !! processedPageQuery ) {

        const { fileHash: newHash, query: newQuery } = processedPageQuery;
        const queryFile = `${GROQ_DIR}/${newHash}.json`;

        await cacheQueryResults( newHash, newQuery );

        // Update all paths using this page component.
        // Is this performant or should we try to leverage custom cache?
        for( let [ path, page ] of pages ) {

          if( page.component !== filePath ) {
            continue;
          }

          reporter.info( `Updating path: ${page.path}` );

          // Run query and inject into page context.
          pageQueryToContext( {
            actions,
            cache,
            file: queryFile,
            nodes,
            page
          } );

        }

      }

    }

    // Static queries.
    if( ! staticQueryMatch ) {
      return reporter.success( 'Finished re-processing page queries' );
    }

    // Run query and save to cache.
    // Files using the static query will be automatically refreshed.
    const staticQuery = await processFileStaticQuery( filePath, nodes, cache );

    if( !! staticQuery ) {

      const { hash, json } = staticQuery;
      await cacheQueryResults( hash, json );

      return reporter.success( 'Finished re-processing queries' );

    }

    reporter.warn( 'There was a problem processing one of your static queries' );

  } );

};

/**
 * Inject page query results its page.
 */
exports.onCreatePage = async ( { actions, cache, getNodes, page, traceId } ) => {

  // Check for hashed page queries for this component.
  const componentPath = page.component;
  const hash = murmurhash( componentPath );
  const queryFile = `${GROQ_DIR}/${hash}.json`;

  if( ! fs.existsSync( queryFile) ) {
    return;
  }

  // Run query and write to page context.
  pageQueryToContext( {
    actions,
    cache,
    file: queryFile,
    getNodes,
    page,
  } );


}

/**
 * Extract page and static queries from all files.
 * Process and cache results.
 *
 * @param {Object} $0       Gatsby Node Helpers.
 */
async function extractQueries( { nodes, traceId, cache } ) {

  reporter.info( 'Getting files for groq extraction...' );

  const filesRegex = `*.+(t|j)s?(x)`
  const pathRegex = `/{${filesRegex},!(node_modules)/**/${filesRegex}}`;
  let hasErrors = false;
  let files = [
    path.join( ROOT, 'src' ),
  ].reduce( ( merged, folderPath ) => {

    merged.push(
      ...glob.sync( path.join( folderPath, pathRegex ), {
        nodir: true,
      } )
    );

    return merged;

  }, [] );

  files = files.filter( d => ! d.match( /\.d\.ts$/ ) );
  files = files.map( normalizePath );

  // Loop through files and look for queries to extract.
  for( let file of files ) {

    const pageQuery = await processFilePageQuery( file, nodes, cache );
    const staticQuery = await processFileStaticQuery( file, nodes, cache );

    // Cache page query.
    // This will only contain a json file of unprocessed query.
    if( !! pageQuery ) {
      const { fileHash, query } = pageQuery;
      cacheQueryResults( fileHash, query );
    }

    // Cache static query.
    // This will contain actual results of the query.
    if( !! staticQuery ) {

      if( staticQuery instanceof Error ) {

        return reporter.warn( 'There was an error processing static query' );

      }
      const { hash, json } = staticQuery;
      cacheQueryResults( hash, json, 'static', );
    }

  }

  reporter.success( 'Finished getting files for query extraction' );


}

/**
 * Cache fragments.
 *
 * @param   {string}  fragmentsDir
 * @param   {Object}  cache
 * @return  {bool}    if succesfully cached.
 */
async function cacheFragments( fragmentsDir, cache ) {

  const index = path.join( fragmentsDir, 'index.js' );

  if( !! fs.readFileSync( index ) ) {

    delete require.cache[ require.resolve( index ) ];

    fragments = require( index );

    await cache.set( 'groq-fragments', fragments );

    reporter.info( 'Cached fragments' );

    return true;

  }

  return false;

}

/**
* Run page query and update the related page via createPage.
*
* @param {Object} $0  Gatsby Node Helpers.
*/
async function pageQueryToContext( { actions, cache, file, getNodes, nodes, page, } ) {

  const { createPage, deletePage, setPageData } = actions;

  // Get query content.
  const content = fs.readFileSync( file, 'utf8' );
  let { unprocessed: query } = JSON.parse( content );

  // Replace any variables within query with context values.
  if( page.context ){

    for( let [ key, value ] of Object.entries( page.context ) ) {

      const search = `\\$${key}`;
      const pattern = new RegExp( search, 'g' );
      query = query.replace( pattern, `"${value}"` );

    }
  }

  // Do the thing.
  try {

    const allNodes = nodes || getNodes();
    const fragments = await cache.get( 'groq-fragments' );
    const { result } = await runQuery( query, allNodes, { file, fragments } );

    page.context.data = result;

    deletePage( page );
    createPage( {
      ...page,
    } );
  }
  catch( err ) {
    console.error( page.component );
    reporter.error( `${err}` );
    reporter.error( query );
  }


}

/**
 * Custom webpack.
 */
exports.onCreateWebpackConfig = async ( { actions, cache, getConfig, loaders, plugins, store } ) => {

  const config = getConfig();


  // Make sure we have have access to GROQ_DIR for useGroqQuery().
  actions.setWebpackConfig( {
    plugins: [
      plugins.define( {
        'process.env.GROQ_DIR': JSON.stringify( GROQ_DIR ),
      } )
    ]
  } );

}

/**
 * Extracts page query from file and returns its hash and unprocessed string.
 *
 * @param   {string}   file
 * @param   {map}      nodes
 * @param   {Object}   cache
 * @return  {Object}   fileHash and query
 */
async function processFilePageQuery( file, nodes, cache ) {

  const contents = fs.readFileSync( file, 'utf8' );
  const match = /export const groqQuery = /.exec( contents );
  if( ! match ) {
    return;
  }

  const ast = parse( file, contents );
  if( ! ast ) {
    return null;
  }

  let pageQuery = null;
  let queryStart = null;
  let queryEnd = null;

  traverse( ast, {
    ExportNamedDeclaration: function( path ) {

      const declarator = path.node.declaration.declarations[0];

      if( declarator.id.name === 'groqQuery' ) {

        queryStart = declarator.init.start;
        queryEnd = declarator.init.end;
        pageQuery = contents.substring( queryStart, queryEnd );

      }

    }
  } );

  if( ! pageQuery ) {
    return;
  }

  const hash = hashQuery( file );

  return {
    fileHash: hash,
    query: JSON.stringify( { unprocessed: pageQuery } ),
  }

}

/**
 * Extracts static query from file and returns its hash and result.
 *
 * @param   {string}  file
 * @param   {map}     nodes
 * @param   {Object}  cache
 * @return  {Object}  hash and query
 */
async function processFileStaticQuery( file, nodes, cache  ) {

  const contents = fs.readFileSync( file, 'utf8' );
  const match = /useGroqQuery/.exec( contents );
  if( ! match ) {
    return;
  }

  const ast = parse( file, contents );
  if( ! ast ) {
    return null;
  }

  let staticQuery = null;
  let queryStart = null;
  let queryEnd = null;

  traverse( ast, {
    CallExpression: function( path ) {

      if( !! path.node.callee && path.node.callee.name === 'useGroqQuery' ) {

        queryStart = path.node.arguments[0].start + 1;
        queryEnd = path.node.arguments[0].end - 1;
        staticQuery = contents.substring( queryStart, queryEnd );

      }

    }
  } );

  if( ! staticQuery ) {
    return null;
  }

  const fragments = await cache.get( 'groq-fragments' );
  const { result, finalQuery } = await runQuery( staticQuery, nodes, { file, fragments } );
  if( result instanceof Error ) {
    return result;
  }

  const hash = hashQuery( finalQuery );
  const json = JSON.stringify( result );

  return { hash, json };

}

/**
 * Cache result from query extraction.
 * For page queries this caches the query itself.
 * For static queries this caches the results of the query.
 *
 * @param {number}          hash  Hash to the json file.
 * @param {Object|string}   data  Data we are caching.
 * @param {string}          type  Page or static query. Optional. Default 'page'
 */
async function cacheQueryResults( hash, data, type = 'page' ) {

  reporter.info( `Caching ${type} query: ${hash}` );

  const json = typeof data !== 'string' ? JSON.stringify( data ) : data;

  if( process.env.NODE_ENV === 'development' ) {

    // Probably a more sophisticated Gatsby way of doing this.
    fs.writeFileSync( `${GROQ_DIR}/${hash}.json`, json, err => {
      if( err ) {
        throw new Error( err );
      }
    } );

  }
  else {

    fs.writeFileSync( `${GROQ_DIR}/${hash}.json`, json, err => {
      if( err ) {
        throw new Error( err );
      }
    } );

  }

}

/**
 * Parse.
 *
 * @param   {string}  filePath
 * @param   {string}  content
 * @param   {Object}  options
 * @return  {ast}
 */
function parse( filePath, content, options = {} ) {

  const { plugins: additionalPlugins, ...additionalOptions } = options;
  let plugins = [ 'jsx' ];

  // This is experimental.
  if( !! babelConfig ) {

    if( !! babelConfig.plugins ) {
      for( let plugin of babelConfig.plugins ) {

        if( typeof plugin !== 'string' || plugin.substr( 0, 6 ) !== '@babel' ) {
          continue;
        }

        let handle = plugin.replace( '@babel/plugin-', '' );
        handle = handle.replace( 'proposal-', '' );
        handle = camelCase( handle );

        plugins.push( handle );

      }
    }
  }

  try {

    const ast = parser.parse( content, {
      errorRecovery: true,
      plugins,
      sourceType: 'module',
      ...additionalOptions,
    } );

    return ast;

  }
  catch( err ) {
    console.error( `Error parsing file: ${filePath}` );
    console.log( err );
    return null;
  }

}

/**
 * Generate a hash based on the query.
 *
 * @param  {string}  query
 * @return {number}
 */
function hashQuery( query ) {
  return murmurhash( query );
}
